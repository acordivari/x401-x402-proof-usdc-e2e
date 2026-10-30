/**
 * The buyer agent on the latest flow: one purchase is a 401 and a 402.
 *
 *   requestProof()      GET the route → 401 + PROOF-REQUEST (decoded)
 *   completePurchase()  package the credential result → token exchange →
 *                       retry with the Verification Token → 402 → pay over
 *                       x402 → 200 receipt
 *   delegatedResult()   under Delegate Authority the agent produces the
 *                       credential result ITSELF: an L3 proof, signed with its
 *                       own key, extending the mandate the person signed
 *
 * Every HTTP exchange can be recorded through `tracingFetch`, which is how
 * the demo shows the 401 → 402 → 200 sequence as it actually happened rather
 * than as a diagram of what should happen.
 */
import {
  DELEGATED_AUTHORITY_QUERY_ID,
  encodeVpToken,
  exchangeForToken,
  presentDelegation,
  readProofRequest,
  readProofResult,
  resultArtifact,
  tokenObjectHeader,
  TX_TEMPLATES,
  type CredentialResult,
  type Jwk,
  type PaymentItemizedPayloadV1,
  type ProofRequirementV1,
  type TokenExchangeResult,
  type X401ErrorObject,
} from "@agentic-payments/credentials";

/** One request/response pair, with only the protocol-relevant headers kept. */
export interface HttpExchange {
  at: number;
  method: string;
  url: string;
  status: number;
  request: Record<string, string>;
  response: Record<string, string>;
  body?: unknown;
}

const REQUEST_HEADERS = ["proof-response", "payment-signature", "x-payment", "idempotency-key", "content-type"];
const RESPONSE_HEADERS = ["proof-request", "proof-result", "payment-required", "payment-response", "x-payment-response", "content-type"];

/** A fetch that appends every exchange it carries to `sink`. */
export function tracingFetch(sink: HttpExchange[], base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const req = new Request(input, init);
    const request: Record<string, string> = {};
    for (const h of REQUEST_HEADERS) {
      const v = req.headers.get(h);
      if (v) request[h] = v;
    }
    const res = await base(req);
    const response: Record<string, string> = {};
    for (const h of RESPONSE_HEADERS) {
      const v = res.headers.get(h);
      if (v) response[h] = v;
    }
    let body: unknown;
    if ((res.headers.get("content-type") ?? "").includes("json")) {
      body = await res.clone().json().catch(() => undefined);
    }
    sink.push({ at: Date.now(), method: req.method, url: req.url, status: res.status, request, response, ...(body !== undefined ? { body } : {}) });
    return res;
  };
}

export interface ProofRequestOutcome {
  status: number;
  /** Present on a 401 (or any response) carrying PROOF-REQUEST. */
  requirement?: ProofRequirementV1;
  body: unknown;
}

export async function requestProof(
  url: string,
  opts: {
    agentId: string;
    /** The person the agent acts for (email) — becomes the request's `login_hint`. */
    loginHint?: string;
    fetch?: typeof fetch;
    headers?: Record<string, string>;
    allowInsecureUri?: boolean;
  },
): Promise<ProofRequestOutcome> {
  // The agent names itself on the request that draws the 401: the merchant binds
  // the proof (and so the payer) to the agent that asked for it.
  const res = await (opts.fetch ?? fetch)(url, {
    headers: {
      ...(opts.headers ?? {}),
      "X401-Agent-Id": opts.agentId,
      ...(opts.loginHint ? { "X401-Login-Hint": opts.loginHint } : {}),
    },
  });
  const requirement = readProofRequest(res.headers, { allowInsecureUri: opts.allowInsecureUri === true });
  return { status: res.status, ...(requirement ? { requirement } : {}), body: await res.json().catch(() => ({})) };
}

export interface PurchaseOutcome {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
  token?: TokenExchangeResult;
  /** A PROOF-RESULT x401 Error Object, when the merchant refused the proof. */
  proofResult?: X401ErrorObject;
}

export async function completePurchase(input: {
  url: string;
  requirement: ProofRequirementV1;
  credentialResult: CredentialResult;
  /** did:pkh of the paying wallet — bound into the artifact so only it can pay. */
  agentId: string;
  /** x402-paying fetch (wrapping a traced fetch, ideally). */
  payingFetch: typeof fetch;
  /** Plain fetch for the token exchange. */
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}): Promise<PurchaseOutcome> {
  const { artifact, header: artifactHeader } = resultArtifact({
    credentialResult: input.credentialResult,
    agentId: input.agentId,
    ...(input.requirement.payload.request_id !== undefined ? { requestId: input.requirement.payload.request_id } : {}),
  });
  let proofHeader = artifactHeader;
  let token: TokenExchangeResult | undefined;
  // Spec's Access Token Acquisition: prefer exchanging the artifact for a
  // Verification Token when the route offers it — the artifact's nonce is
  // single-use, the token survives the 402 round-trip.
  if (input.requirement.payload.oauth) {
    token = await exchangeForToken({ payload: input.requirement.payload, artifact, ...(input.fetch ? { fetch: input.fetch } : {}) });
    if (!token.ok || !token.accessToken) return { ok: false, status: token.status, body: token.body, token };
    proofHeader = tokenObjectHeader(token.accessToken);
  }
  const res = await input.payingFetch(input.url, { headers: { ...(input.headers ?? {}), "PROOF-RESPONSE": proofHeader } });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const proofResult = readProofResult(res.headers);
  return { ok: res.ok, status: res.status, body, ...(token ? { token } : {}), ...(proofResult ? { proofResult } : {}) };
}

/**
 * Answer a PROOF-REQUEST under Delegate Authority: the checkout is the basket
 * the merchant's signed request asked for, and the agent's L3 binds it to that
 * request's nonce and client_id.
 */
export async function delegatedResult(input: {
  requirement: ProofRequirementV1;
  delegation: string;
  agentPrivateJwk: Jwk;
  merchant: { id: string; name: string };
  sku: string;
  category: string;
}): Promise<CredentialResult> {
  const basket = input.requirement.transactionData.find((t) => t.type === TX_TEMPLATES.paymentItemized)?.payload as
    | PaymentItemizedPayloadV1
    | undefined;
  if (!basket) throw new Error("the merchant's request carries no itemized basket to sign for");
  const items = basket.items.map((i) => ({ sku: input.sku, label: i.label, category: input.category, quantity: i.quantity, unit_cost: i.unit_cost }));
  const total = Math.round(items.reduce((s, i) => s + i.quantity * i.unit_cost, 0) * 100) / 100;
  const presentation = await presentDelegation({
    delegation: input.delegation,
    agentPrivateJwk: input.agentPrivateJwk,
    audience: input.requirement.claims.client_id,
    nonce: input.requirement.claims.nonce,
    checkout: { merchant: input.merchant, items, currency: basket.currency, total },
  });
  return { protocol: "openid4vp-v1-signed", data: { vp_token: encodeVpToken({ [DELEGATED_AUTHORITY_QUERY_ID]: [presentation] }) } };
}
