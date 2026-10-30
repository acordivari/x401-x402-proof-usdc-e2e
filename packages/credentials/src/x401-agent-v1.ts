/**
 * The agent's side of a current x401 exchange — what a user agent does
 * between a 401 PROOF-REQUEST and the retry, on @proof.com/x401-node:
 *
 *   readProofRequest   decode PROOF-REQUEST and the signed DC API request in it
 *   resultArtifact     package a `{ protocol, data }` credential result, with the
 *                      agent's did:pkh as `agent_id` (the deployment binds it)
 *   exchangeForToken   RFC 8693 token exchange at the payload's `oauth.token_endpoint`
 *   tokenObjectHeader  the Verification Token as a PROOF-RESPONSE Token Object
 *   readProofResult    decode a PROOF-RESULT x401 Error Object
 *
 * How the credential result is obtained is deliberately NOT here: in a browser
 * it is `navigator.credentials.get(payload.credential_requirements)`, through
 * a relay it comes back to a `return_uri`, and under Delegate Authority the
 * agent signs it itself. Those are the three paths the spec names.
 */
import { agent as x401agent, type CredentialResult, type ResultArtifact, type X401ErrorObject, type X401Payload } from "@proof.com/x401-node";
import { decodeDcApiRequest, type DcApiRequestClaims } from "./dc-api-request.ts";
import { decodeTxData, type TransactionDataV1 } from "./templates.ts";

export type { CredentialResult, ResultArtifact, X401ErrorObject, X401Payload };

export interface ProofRequirementV1 {
  payload: X401Payload;
  /** The signed request object (compact JWS) of the first `openid4vp-v1-signed` entry. */
  request: string;
  claims: DcApiRequestClaims;
  /** The Sign Transactions terms carried in the request, decoded. */
  transactionData: TransactionDataV1[];
}

export function readProofRequest(headers: Headers | Record<string, string | string[] | undefined>, options?: { allowInsecureUri?: boolean }): ProofRequirementV1 | undefined {
  const req = x401agent.detectProofRequirement({ headers: headers as never }, options);
  if (!req) return undefined;
  return describeProofRequest(req.payload);
}

export function describeProofRequest(payload: X401Payload): ProofRequirementV1 {
  const entry = x401agent.getDigitalCredentialRequest(payload).requests.find((r) => r.protocol === "openid4vp-v1-signed");
  const request = (entry?.data as { request?: unknown } | undefined)?.request;
  if (typeof request !== "string") throw new Error("PROOF-REQUEST carries no signed openid4vp request");
  const { claims } = decodeDcApiRequest(request);
  return { payload, request, claims, transactionData: (claims.transaction_data ?? []).map(decodeTxData) };
}

export function resultArtifact(input: { credentialResult: CredentialResult; agentId?: string; requestId?: string }): { artifact: ResultArtifact; header: string } {
  const artifact = x401agent.buildResultArtifact({
    credentialResult: input.credentialResult,
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
  });
  return { artifact, header: x401agent.encodeResultArtifact(artifact) };
}

export interface TokenExchangeResult {
  ok: boolean;
  status: number;
  accessToken?: string;
  expiresIn?: number;
  body: Record<string, unknown>;
}

export async function exchangeForToken(input: {
  payload: X401Payload;
  artifact: ResultArtifact;
  fetch?: typeof fetch;
}): Promise<TokenExchangeResult> {
  const oauth = input.payload.oauth;
  if (!oauth) throw new Error("this PROOF-REQUEST offers no token exchange (no oauth member)");
  const form = x401agent.buildTokenExchangeForm(input.artifact, {
    ...(oauth.resource !== undefined ? { resource: oauth.resource } : {}),
    ...(oauth.audience !== undefined ? { audience: oauth.audience } : {}),
  });
  const res = await (input.fetch ?? fetch)(oauth.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) return { ok: false, status: res.status, body };
  const parsed = x401agent.parseTokenExchangeResponse(body);
  return { ok: true, status: res.status, accessToken: parsed.access_token, ...(parsed.expires_in !== undefined ? { expiresIn: parsed.expires_in } : {}), body };
}

export function tokenObjectHeader(accessToken: string): string {
  return x401agent.encodeTokenObject(x401agent.buildTokenObject(accessToken));
}

export function readProofResult(headers: Headers): X401ErrorObject | undefined {
  const raw = headers.get("proof-result");
  if (!raw) return undefined;
  try {
    return x401agent.decodeErrorObject(raw);
  } catch {
    return undefined;
  }
}
