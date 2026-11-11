/**
 * Verifying a current Proof `vp_token` — the seam behind the latest x401 gate.
 *
 *   - `localPresentationVerifierV1` : self-issued ProofCredentialV1-shaped
 *     credentials against a pinned issuer key (offline / tests / public demo)
 *   - `proofPresentationVerifierV1` : (proof-sdk-v1.ts) the Proof SDK's
 *     `verifyVPToken`, chain-validated to Proof's committed roots
 *
 * Both do the same job as the SDK, check for check: restore detached
 * signatures when the KB-JWT says they are detached (paying for them if the
 * resolver can), issuer signature + disclosure digests, `typ: dc+sd-jwt`,
 * pinned `iss`, the KB-JWT signature under `cnf.jwk`, `sd_hash`, `aud` equal
 * to our client_id, and a fresh `iat`. Neither consumes the nonce — that is
 * the caller's single-use store, which is what makes it a replay gate.
 */
import { collect, type ValidationResult } from "@agentic-payments/shared";
import { createSdJwtVc, type Jwk } from "./crypto.ts";
import { decodeJwsPart } from "./jws.ts";
import { attachSignatures, decodeVpToken, detachedSignatureId } from "./wallet-v1.ts";
import type { DetachedSignatureResolver, SignaturePayment } from "./detached-signatures.ts";
import { ES256 } from "@owf/crypto";

export const REGISTERED_CLAIMS = new Set([
  "iss", "vct", "vct#integrity", "cnf", "iat", "exp", "nbf", "sub", "status", "_sd", "_sd_alg",
]);

export interface VerifiedPresentationV1 {
  /** vp_token key: the DCQL credential query id (`proof_id_default`, ...). */
  credentialQueryId: string;
  /** `ProofCredentialV1` for Proof; `ProofCredentialV1-shape` for a self-issued one. */
  credentialType: string;
  issuer: string;
  vct: string;
  /** Disclosed claims only, nested as issued (registered JWT claims removed). */
  claims: Record<string, unknown>;
  nonce: string;
  aud: string;
  iat: number;
  /** The full signed KB-JWT payload — where Sign Transactions terms come back. */
  kbPayload: Record<string, unknown>;
  holderJwk: Jwk;
  /** The signatures had to be fetched (and paid for) before this verified. */
  detachedSignatures: boolean;
  /** What the issuer signature chained to. */
  trustAnchor: string;
  issuerCert?: { subject?: string; issuer?: string };
}

export interface VpTokenVerification {
  result: ValidationResult;
  presentations: VerifiedPresentationV1[];
  /** x402 payments made to unlock detached signatures during this verification. */
  signaturePayments: SignaturePayment[];
}

export interface VerifyVpTokenInput {
  encodedVpToken: string;
  /** Our client_id — the KB-JWT must be addressed to it. */
  aud: string;
}

export interface PresentationVerifierV1 {
  /** Human label for the trust anchor (shown in the UI). */
  readonly trustAnchor: string;
  verifyVpToken(input: VerifyVpTokenInput): Promise<VpTokenVerification>;
}

export interface LocalPresentationVerifierV1Options {
  issuerId: string;
  issuerPublicJwk: Jwk;
  vct: string;
  /** Where to buy back detached signatures; absent => detached presentations fail closed. */
  signatures?: DetachedSignatureResolver;
  /** KB-JWT max age. Proof recommends 5 minutes. */
  maxAgeSeconds?: number;
  /** unix seconds */
  now?: () => number;
}

export function localPresentationVerifierV1(opts: LocalPresentationVerifierV1Options): PresentationVerifierV1 {
  const maxAge = opts.maxAgeSeconds ?? 300;
  const trustAnchor = `pinned local issuer key (${opts.issuerId})`;
  return {
    trustAnchor,
    async verifyVpToken({ encodedVpToken, aud }) {
      const violations: string[] = [];
      const presentations: VerifiedPresentationV1[] = [];
      const signaturePayments: SignaturePayment[] = [];
      let map: Record<string, string[]>;
      try {
        map = decodeVpToken(encodedVpToken);
      } catch (err) {
        return { result: collect([`malformed vp_token: ${(err as Error).message}`]), presentations, signaturePayments };
      }
      const issuerVerify = await ES256.getVerifier(opts.issuerPublicJwk);
      const inst = await createSdJwtVc({ issuerVerifier: (d, s) => issuerVerify(d, s) });

      for (const [credentialQueryId, list] of Object.entries(map)) {
        for (let presentation of list) {
          try {
            const recordId = detachedSignatureId(presentation);
            let detached = false;
            if (recordId) {
              if (!opts.signatures) throw new Error("presentation signatures are detached and no signature resolver is configured");
              const { signatures, payment } = await opts.signatures.resolve(recordId);
              presentation = attachSignatures(presentation, signatures);
              if (payment) signaturePayments.push(payment);
              detached = true;
            }
            const parts = presentation.split("~");
            const header = decodeJwsPart(parts[0]!.split(".")[0]!);
            if (header.typ !== "dc+sd-jwt") throw new Error(`JWT header typ ${String(header.typ)} is not dc+sd-jwt`);
            const kbSeg = parts[parts.length - 1]!;
            if (!kbSeg.includes(".")) throw new Error("presentation has no Key Binding JWT");
            const kbNonce = decodeJwsPart(kbSeg.split(".")[1]!).nonce;
            if (typeof kbNonce !== "string") throw new Error("KB-JWT carries no nonce");
            const nowS = opts.now?.() ?? Math.floor(Date.now() / 1000);
            const res = await inst.verify(presentation, {
              keyBindingNonce: kbNonce,
              expectedIssuer: opts.issuerId,
              expectedVct: opts.vct,
              expectedKeyBindingAudience: aud,
              keyBindingMaxAgeSeconds: maxAge,
              currentDate: nowS,
            });
            if (!res.kb) throw new Error("KB-JWT did not verify");
            const payload = res.payload as Record<string, unknown>;
            const kbPayload = res.kb.payload as unknown as Record<string, unknown>;
            presentations.push({
              credentialQueryId,
              credentialType: "ProofCredentialV1-shape",
              issuer: String(payload.iss),
              vct: String(payload.vct),
              claims: Object.fromEntries(Object.entries(payload).filter(([k]) => !REGISTERED_CLAIMS.has(k))),
              nonce: kbNonce,
              aud: String(kbPayload.aud),
              iat: Number(kbPayload.iat),
              kbPayload,
              holderJwk: (payload.cnf as { jwk: Jwk }).jwk,
              detachedSignatures: detached,
              trustAnchor,
            });
          } catch (err) {
            violations.push(`${credentialQueryId}: ${(err as Error).message}`);
          }
        }
      }
      if (presentations.length === 0 && violations.length === 0) violations.push("vp_token carried no presentations");
      return { result: collect(violations), presentations, signaturePayments };
    },
  };
}

/**
 * Verify a holder credential presented WITHOUT a KB-JWT — the L1 link of a
 * delegation chain, where the holder's binding is the L2 signature instead.
 */
export function localL1Verifier(opts: { issuerId: string; issuerPublicJwk: Jwk; vct: string }) {
  return async (l1: string) => {
    const issuerVerify = await ES256.getVerifier(opts.issuerPublicJwk);
    const inst = await createSdJwtVc({ issuerVerifier: (d, s) => issuerVerify(d, s) });
    const header = decodeJwsPart(l1.split("~")[0]!.split(".")[0]!);
    if (header.typ !== "dc+sd-jwt") throw new Error(`JWT header typ ${String(header.typ)} is not dc+sd-jwt`);
    const res = await inst.verify(l1, { expectedIssuer: opts.issuerId, expectedVct: opts.vct });
    const payload = res.payload as Record<string, unknown>;
    const holderJwk = (payload.cnf as { jwk?: Jwk } | undefined)?.jwk;
    if (!holderJwk) throw new Error("credential is not bound to a holder key (cnf)");
    return {
      issuer: String(payload.iss),
      vct: String(payload.vct),
      claims: Object.fromEntries(Object.entries(payload).filter(([k]) => !REGISTERED_CLAIMS.has(k))),
      holderJwk,
      trustAnchor: `pinned local issuer key (${opts.issuerId})`,
    };
  };
}
