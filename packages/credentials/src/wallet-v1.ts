/**
 * The holder side of a current Proof presentation, as our in-page demo wallet
 * performs it — the same bytes Proof's Cloud Wallet returns:
 *
 *   vp_token = base64url({ "<credential query id>": ["<issuer-jwt>~<disclosures>~<kb-jwt>"] })
 *
 * The Key Binding JWT carries `nonce`, `aud` (the verifier's client_id),
 * `iat`, `sd_hash`, and — for Sign Transactions — every requested
 * `transaction_data` payload as a top-level claim named after its template.
 *
 * Detached signatures: a verifier with no payment method on file at Proof
 * receives the presentation with BOTH signature segments emptied and a `crit`
 * KB-JWT header naming the signature record; it buys the signatures back over
 * x402. `presentCredentialV1({ detachedSignatureId })` produces exactly that
 * shape so the emulated flow exercises the real restore path. Browser-safe.
 */
import { sha256Base64url, type Jwk } from "./crypto.ts";
import { b64urlDecodeToString, b64urlJson, decodeJwsPart, signCompactJws } from "./jws.ts";
import { createSdJwtVc } from "./crypto.ts";
import { presentationFrameFor, type ClaimPath } from "./proof-credential-v1.ts";
import { TX_TEMPLATE_CLAIM, type TransactionDataV1 } from "./templates.ts";

/** The critical KB-JWT header that names a detached-signature record. */
export const DETACHED_SIGNATURE_HEADER = "proof.com#sig-1";

export interface DetachedSignatures {
  issuer_signature: string;
  kb_signature: string;
}

export interface PresentV1Input {
  /** The held credential: issuer-signed JWT + all disclosures (`…~`). */
  credential: string;
  holderPrivateJwk: Jwk;
  /** Exactly the claim paths the request's scope discloses. */
  disclose: ClaimPath[];
  nonce: string;
  /** The verifier's client_id. */
  audience: string;
  transactionData?: TransactionDataV1[];
  /** When set, emit a detached-signature presentation under this record id. */
  detachedSignatureId?: string;
  /** Clock override, unix seconds. */
  now?: () => number;
}

export interface PresentV1Output {
  /** The full, signed presentation. */
  presentation: string;
  /** The KB-JWT payload that was signed. */
  kbPayload: Record<string, unknown>;
  /** Present when `detachedSignatureId` was set: what the verifier receives + what it must buy back. */
  detached?: { id: string; presentation: string; signatures: DetachedSignatures };
}

export async function presentCredentialV1(input: PresentV1Input): Promise<PresentV1Output> {
  const inst = await createSdJwtVc({});
  // present() without kb options = issuer JWT + the selected disclosures, `~`-terminated.
  const withoutKb = await inst.present(input.credential, presentationFrameFor(input.disclose) as never);
  const sdHash = await sha256Base64url(withoutKb);
  const iat = input.now ? input.now() : Math.floor(Date.now() / 1000);
  const kbPayload: Record<string, unknown> = {
    iat,
    aud: input.audience,
    nonce: input.nonce,
    sd_hash: sdHash,
  };
  for (const td of input.transactionData ?? []) kbPayload[TX_TEMPLATE_CLAIM[td.type]] = td.payload;
  const header: Record<string, unknown> = { typ: "kb+jwt" };
  if (input.detachedSignatureId) {
    header.crit = [DETACHED_SIGNATURE_HEADER];
    header[DETACHED_SIGNATURE_HEADER] = input.detachedSignatureId;
  }
  const kbJwt = await signCompactJws(header, kbPayload, input.holderPrivateJwk);
  const presentation = `${withoutKb}${kbJwt}`;
  if (!input.detachedSignatureId) return { presentation, kbPayload };
  const { stripped, signatures } = detachSignatures(presentation);
  return { presentation, kbPayload, detached: { id: input.detachedSignatureId, presentation: stripped, signatures } };
}

/** Empty both signature segments, returning them for deposit with the signature service. */
export function detachSignatures(presentation: string): { stripped: string; signatures: DetachedSignatures } {
  const parts = presentation.split("~");
  const issuer = parts[0]!.split(".");
  const kb = parts[parts.length - 1]!.split(".");
  if (issuer.length !== 3 || kb.length !== 3) throw new Error("presentation has no issuer JWT or KB-JWT to detach");
  const signatures = { issuer_signature: issuer[2]!, kb_signature: kb[2]! };
  parts[0] = `${issuer[0]}.${issuer[1]}.`;
  parts[parts.length - 1] = `${kb[0]}.${kb[1]}.`;
  return { stripped: parts.join("~"), signatures };
}

/** Put fetched signatures back: issuer JWT first segment, KB-JWT last. */
export function attachSignatures(presentation: string, sigs: DetachedSignatures): string {
  const parts = presentation.split("~");
  const issuer = parts[0]!.split(".");
  const kb = parts[parts.length - 1]!.split(".");
  parts[0] = `${issuer[0]}.${issuer[1]}.${sigs.issuer_signature}`;
  parts[parts.length - 1] = `${kb[0]}.${kb[1]}.${sigs.kb_signature}`;
  return parts.join("~");
}

/**
 * The detached-signature record id, if the KB-JWT names one AND its signatures
 * are missing. Throws on any `crit` parameter we do not implement — RFC 7515
 * requires rejecting those rather than ignoring them.
 */
export function detachedSignatureId(presentation: string): string | undefined {
  const parts = presentation.split("~");
  const issuer = parts[0]!.split(".");
  const kb = parts.length > 1 ? parts[parts.length - 1]!.split(".") : [];
  if (issuer.length !== 3 || kb.length !== 3) return undefined;
  const header = decodeJwsPart<Record<string, unknown>>(kb[0]!);
  const crit = header.crit;
  if (crit === undefined) return undefined;
  if (!Array.isArray(crit) || crit.length === 0) throw new Error("KB-JWT crit header must be a non-empty array");
  for (const name of crit) {
    if (name !== DETACHED_SIGNATURE_HEADER) throw new Error(`unsupported critical KB-JWT header ${String(name)}`);
  }
  const id = header[DETACHED_SIGNATURE_HEADER];
  if (typeof id !== "string" || id.length === 0) throw new Error(`${DETACHED_SIGNATURE_HEADER} must be a non-empty string`);
  return issuer[2]!.length > 0 && kb[2]!.length > 0 ? undefined : id;
}

/** vp_token envelope, Proof style: base64url JSON keyed by credential query id. */
export function encodeVpToken(map: Record<string, string[]>): string {
  return b64urlJson(map);
}

/**
 * Accept either envelope a DC API result can carry — the base64url string
 * Proof posts, or the JSON object OID4VP-over-DC-API returns — and normalize
 * to the base64url string the SDK's `verifyVPToken` takes.
 */
export function normalizeVpToken(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) return encodeVpToken(value as Record<string, string[]>);
  throw new Error("vp_token must be a base64url string or a JSON object");
}

export function decodeVpToken(encoded: string): Record<string, string[]> {
  const obj = JSON.parse(b64urlDecodeToString(encoded)) as unknown;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("vp_token must decode to an object");
  for (const [k, v] of Object.entries(obj)) {
    if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) throw new Error(`vp_token["${k}"] must be an array of strings`);
  }
  return obj as Record<string, string[]>;
}

/** Decode a presentation for display (no verification): claims + KB payload. */
export async function inspectPresentation(presentation: string): Promise<{
  claims: Record<string, unknown>;
  kbPayload?: Record<string, unknown>;
  issuerHeader: Record<string, unknown>;
}> {
  const inst = await createSdJwtVc({});
  const claims = (await inst.getClaims(presentation)) as Record<string, unknown>;
  const parts = presentation.split("~");
  const last = parts[parts.length - 1]!;
  return {
    claims,
    ...(last.includes(".") ? { kbPayload: decodeJwsPart(last.split(".")[1]!) } : {}),
    issuerHeader: decodeJwsPart(parts[0]!.split(".")[0]!),
  };
}

export { b64urlDecodeToString };
