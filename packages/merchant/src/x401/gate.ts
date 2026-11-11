/**
 * The merchant as an x401 verifier — the latest flow's gate on `/x401/buy/:sku`,
 * in front of the same x402 paywall `/buy` uses. One route, three legs:
 *
 *   1. GET  /x401/buy/:sku                    → 401 + PROOF-REQUEST (signed DC API
 *                                              request with the itemized basket,
 *                                              token endpoint, x402 payment hint)
 *   2. POST /x401/token  (RFC 8693, subject = Result Artifact)
 *                                            → a short-lived Verification Token
 *                                              bound to this route
 *   3. GET  /x401/buy/:sku + PROOF-RESPONSE   → 402 PAYMENT-REQUIRED (proof done,
 *        (Token Object, or the artifact)       payment not), then with the x402
 *                                              payment → 200 receipt
 *
 * x401 and x402 stay separate, as the spec requires: proof never stands in for
 * payment, and a 402 is only ever about money. What joins them is checked
 * here before settlement — the payer must be the agent that asked for the
 * proof (it declares its did:pkh in `X401-Agent-Id` on the first request, the
 * person's presentation signs that request's nonce, and the basket they sign
 * names the paying wallet), paying exactly the catalog price, and a delegated
 * purchase must fit the mandate's cumulative budget.
 */
import { randomBytes } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  X401_ACCESS_TOKEN_TYPE,
  paymentItemized,
  sessionData,
  type TransactionDataV1,
  type VerifiedProofV1,
  type X401ErrorCode,
  type X401VerifierV1,
} from "@agentic-payments/credentials";
import { dollarsToAtomic, parseAgentDid } from "@agentic-payments/shared";
import { canonicalSku } from "../x402-headers.ts";
import { findProduct, productPriceAtomic, type Product } from "../catalog.ts";
import { decodePaymentAuthorization } from "../x402-headers.ts";
import type { SpendLedger } from "../spend-ledger.ts";

export const X401_BUY_PREFIX = "/x401/buy";
export const X401_TOKEN_PATH = "/x401/token";
/** Deployment-specific agent binding: the requesting agent's did:pkh, sent on the request that draws the 401. */
export const AGENT_ID_HEADER = "X401-Agent-Id";
/**
 * Optional: the person the agent acts for (an email), copied into the signed
 * request as `login_hint` so a wallet provider like Proof knows whom to ask.
 */
export const LOGIN_HINT_HEADER = "X401-Login-Hint";
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

export interface X401GateOptions {
  verifier: X401VerifierV1;
  merchantName: string;
  network: `eip155:${number}`;
  ledger: SpendLedger;
  /** Also bind a `session_data` template (only when the request signer can carry two). */
  sessionData?: boolean;
  tokenTtlSeconds?: number;
  /** unix seconds */
  now?: () => number;
}

interface TokenRecord {
  token: string;
  resource: string;
  proof: VerifiedProofV1;
  expiresAt: number;
  spent: boolean;
}

/** What a receipt (and the demo UI) learns about how this purchase was authorized. */
export interface X401Authorization {
  kind: VerifiedProofV1["kind"];
  via: "verification-token" | "result-artifact";
  principal?: VerifiedProofV1["principal"];
  agentId?: string;
  mandateId?: string;
  detachedSignatures: boolean;
  signaturePayments: VerifiedProofV1["signaturePayments"];
  terms?: VerifiedProofV1["terms"];
}

export function summarizeProof(proof: VerifiedProofV1, via: X401Authorization["via"]): X401Authorization {
  return {
    kind: proof.kind,
    via,
    ...(proof.principal ? { principal: proof.principal } : {}),
    ...(proof.agentId ? { agentId: proof.agentId } : {}),
    ...(proof.mandate ? { mandateId: proof.mandate.id } : {}),
    detachedSignatures: proof.detachedSignatures,
    signaturePayments: proof.signaturePayments,
    ...(proof.terms ? { terms: proof.terms } : {}),
  };
}

/**
 * The basket this route asks the person (or their mandate) to sign for. The
 * description names the paying agent, so the person's signature covers WHO
 * pays as well as what is bought.
 */
export function basketFor(product: Product, merchantName: string, agentId: string): TransactionDataV1 {
  const agent = parseAgentDid(agentId);
  return paymentItemized({
    title: `${merchantName} order`,
    description: `Paid by agent wallet ${agent?.address ?? agentId} on ${agent?.network ?? "unknown network"}`,
    currency: "USD",
    items: [{ quantity: 1, unit_cost: Number(product.priceUsd), label: product.name }],
  });
}

export function createX401Gate(opts: X401GateOptions): { gate: RequestHandler; tokenEndpoint: RequestHandler } {
  const tokens = new Map<string, TokenRecord>();
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const ttl = opts.tokenTtlSeconds ?? 300;
  const sweep = () => {
    const t = now();
    for (const [k, r] of tokens) if (r.expiresAt <= t) tokens.delete(k);
  };

  const originOf = (req: Request) => `${req.protocol}://${req.get("host")}`;

  async function challenge(
    req: Request,
    res: Response,
    product: Product,
    failure?: { status: number; code: X401ErrorCode; description: string },
  ) {
    const agentId = req.header(AGENT_ID_HEADER) ?? "";
    if (!parseAgentDid(agentId)) {
      return res.status(400).json({
        error: "agent_id_required",
        error_description: `this route binds the paying agent: send its did:pkh in ${AGENT_ID_HEADER}`,
      });
    }
    const loginHint = req.header(LOGIN_HINT_HEADER);
    if (loginHint !== undefined && !EMAIL.test(loginHint)) {
      return res.status(400).json({ error: "invalid_login_hint", error_description: `${LOGIN_HINT_HEADER} must be an email address` });
    }
    const resource = `${X401_BUY_PREFIX}/${product.sku}`;
    const terms = [basketFor(product, opts.merchantName, agentId)];
    if (opts.sessionData) terms.push(sessionData({ ip_address: req.ip ?? "0.0.0.0" }));
    const origin = originOf(req);
    const { header } = await opts.verifier.challenge({
      resource,
      sku: product.sku,
      agentId,
      ...(loginHint ? { loginHint } : {}),
      terms,
      tokenEndpoint: `${origin}${X401_TOKEN_PATH}`,
      resourceUrl: `${origin}${resource}`,
      payment: { required: true, scheme_hint: "x402", notes: `${product.priceUsd} USDC on ${opts.network}, after proof` },
    });
    res.setHeader("PROOF-REQUEST", header);
    res.setHeader("Cache-Control", "no-store");
    if (failure) res.setHeader("PROOF-RESULT", opts.verifier.errorHeader(failure.code, failure.description));
    res.status(failure?.status ?? 401).json(
      failure
        ? { error: failure.code, error_description: failure.description }
        : { error: "proof_required", sku: product.sku },
    );
  }

  const deny = (res: Response, code: X401ErrorCode | "payer_agent_mismatch" | "payment_mismatch", description: string, status = 403) => {
    if (code !== "payer_agent_mismatch" && code !== "payment_mismatch") {
      res.setHeader("PROOF-RESULT", opts.verifier.errorHeader(code, description));
    }
    res.status(status).json({ error: code, error_description: description });
  };

  const gate: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      // Fail closed on anything but the canonical `/<sku>`: Express and the x402
      // route matcher both accept variant spellings (`/sku/`, `%2D`), and a
      // `next()` here would let one reach the paywall and fulfilment unproven.
      const sku = canonicalSku(req.path);
      const product = sku ? findProduct(sku) : undefined;
      if (!sku || !product) return res.status(404).json({ error: "unknown sku" });
      const resource = `${X401_BUY_PREFIX}/${sku}`;

      // Read the payment header exactly as x402 will. Unreadable or ambiguous is
      // refused here, never mistaken for "unpaid".
      const payment = decodePaymentAuthorization(req);
      if (payment.present && !payment.complete) return deny(res, "payment_mismatch", "malformed or ambiguous payment header", 400);

      const header = req.header("proof-response");
      if (!header) return challenge(req, res, product);

      sweep();
      let proof: VerifiedProofV1;
      let token: TokenRecord | undefined;
      const tokenObject = opts.verifier.tryDecodeTokenObject(header);
      if (tokenObject) {
        token = tokens.get(tokenObject.access_token);
        if (!token || token.spent || token.expiresAt <= now() || token.resource !== resource) {
          return challenge(req, res, product, { status: 401, code: "invalid_token", description: "verification token is unknown, expired, spent, or for another route" });
        }
        // Claim a single-use token SYNCHRONOUSLY, before any await, so two
        // concurrent paid retries cannot both ride it. A refused payment gives
        // it back.
        if (payment.present) {
          const t = token;
          t.spent = true;
          res.on("finish", () => { if (res.statusCode !== 200) t.spent = false; });
        }
        proof = token.proof;
      } else {
        try {
          const artifact = opts.verifier.decodeArtifact(header);
          proof = await opts.verifier.verifyArtifact(artifact, { resource, consume: false });
        } catch (err) {
          return challenge(req, res, product, { status: 400, code: "invalid_response", description: (err as Error).message });
        }
        if (!proof.result.ok) {
          return challenge(req, res, product, { status: 403, code: proof.code ?? "invalid_result", description: proof.result.violations.join("; ") });
        }
      }
      // What can change after verification — a mandate's expiry or revocation —
      // is re-checked now, at the point of spending.
      const status = await opts.verifier.recheck(proof);
      if (!status.result.ok) return deny(res, status.code ?? "invalid_result", status.result.violations.join("; "));
      res.locals.x401 = summarizeProof(proof, token ? "verification-token" : "result-artifact");

      // Delegated: cumulative budget feasibility, even at the unpaid 402 stage
      // (fail closed if the ledger cannot answer).
      const price = productPriceAtomic(sku);
      const budgetAtomic = proof.mandate ? dollarsToAtomic(proof.mandate.budget.max.toFixed(2)) : undefined;
      if (proof.mandate && budgetAtomic !== undefined) {
        let prior: bigint;
        try {
          prior = BigInt(await opts.ledger.total(proof.mandate.id));
        } catch {
          return deny(res, "policy_not_satisfied", "spend ledger unavailable");
        }
        if (prior + price > budgetAtomic) {
          return deny(res, "policy_not_satisfied", `purchase would exceed the mandate's budget of ${proof.mandate.budget.max.toFixed(2)} ${proof.mandate.budget.currency}`);
        }
      }

      if (!payment.present) return next(); // proof satisfied → x402 emits 402

      // Agent binding: the proof is bound to the agent that requested it; the
      // signed EIP-3009 `from` (on our chain) must be that agent.
      const bound = proof.agentId ? parseAgentDid(proof.agentId) : undefined;
      if (!bound || bound.address !== payment.from!.toLowerCase() || bound.network !== opts.network) {
        return deny(res, "payer_agent_mismatch", `payer ${payment.from} on ${opts.network} is not the agent ${proof.agentId ?? "(none)"} the proof binds`);
      }
      if (payment.value !== price.toString()) {
        return deny(res, "payment_mismatch", `signed amount ${payment.value} is not the catalog price ${price}`);
      }

      // Direct-artifact path: burn the nonce BEFORE settlement starts.
      if (!token && proof.nonce && !(await opts.verifier.consume(proof.nonce))) {
        return deny(res, "invalid_nonce", "this proof was already used", 401);
      }
      if (proof.mandate && budgetAtomic !== undefined) {
        const reservation = await opts.ledger.reserve(proof.mandate.id, payment.nonce!, price, budgetAtomic);
        if (!reservation.ok) return deny(res, "policy_not_satisfied", reservation.violations.join("; "));
        const nonce = payment.nonce!;
        res.on("finish", () => { if (res.statusCode !== 200) void opts.ledger.release(nonce); });
      }
      next();
    })().catch(next);
  };

  const tokenEndpoint: RequestHandler = (req, res) => {
    void (async () => {
      let parsed: ReturnType<X401VerifierV1["parseTokenExchange"]>;
      try {
        parsed = opts.verifier.parseTokenExchange(req.body ?? {});
      } catch (err) {
        return res.status(400).json({ error: "invalid_request", error_description: (err as Error).message });
      }
      let resource: string;
      try {
        resource = new URL(parsed.resource ?? "").pathname;
      } catch {
        return res.status(400).json({ error: "invalid_target", error_description: "resource must be the protected route URL" });
      }
      if (!resource.startsWith(`${X401_BUY_PREFIX}/`) || !findProduct(resource.slice(X401_BUY_PREFIX.length + 1))) {
        return res.status(400).json({ error: "invalid_target", error_description: `no x401-protected route at ${resource}` });
      }
      const proof = await opts.verifier.verifyArtifact(parsed.artifact, { resource, consume: true });
      if (!proof.result.ok) {
        res.setHeader("PROOF-RESULT", opts.verifier.errorHeader(proof.code ?? "invalid_result", proof.result.violations.join("; ")));
        return res.status(400).json({ error: "invalid_grant", error_description: proof.result.violations.join("; "), x401_error: proof.code });
      }
      sweep();
      const token = randomBytes(32).toString("base64url");
      tokens.set(token, { token, resource, proof, expiresAt: now() + ttl, spent: false });
      res.setHeader("Cache-Control", "no-store");
      res.json({
        access_token: token,
        issued_token_type: X401_ACCESS_TOKEN_TYPE,
        token_type: "Bearer",
        expires_in: ttl,
        x401: JSON.parse(JSON.stringify({ resource, ...summarizeProof(proof, "verification-token") })),
      });
    })().catch((err) => res.status(500).json({ error: "server_error", error_description: String(err) }));
  };

  return { gate, tokenEndpoint };
}
