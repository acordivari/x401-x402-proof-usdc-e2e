/**
 * The verifiable-credentials verification seam (local implementation).
 *
 *   - localVcVerifier    : verifies a self-issued SD-JWT-VC against a known
 *                          trust anchor (offline; the test/CI + offline-demo
 *                          substrate)
 *   - proofSdkVcVerifier : (proof-sdk.ts) verifies a real Proof presentation
 *                          via the official @proof.com/proof-vc-common SDK,
 *                          pinned to Proof's committed trust store
 *
 * Both check the issuer signature, the holder key-binding (KB-JWT) against the
 * verifier's nonce, and surface the disclosed claims. (A hand-rolled x5c
 * chain-walk verifier for live Proof tokens existed before the SDK adoption;
 * it was removed once every live caller went through the SDK — see git
 * history if a trust-pin override ever needs resurrecting.)
 */
import { collect } from "@agentic-payments/shared";
import type { Verifier } from "@sd-jwt/types";
import { createSdJwtVc, type Jwk } from "./crypto.ts";
import type {
  PresentationProof,
  VerifiableCredentialVerifier,
  VerifyPresentationInput,
} from "./types.ts";

/** Resolve an issuer's public verification key from its `iss` value. */
export type IssuerKeyResolver = (iss: string) => Promise<Jwk>;

/** JWT registered/SD-JWT-VC claims that are not user-disclosed attributes. */
const RESERVED_CLAIMS = new Set([
  "iss", "vct", "vct#integrity", "cnf", "iat", "exp", "nbf", "sub", "status", "_sd", "_sd_alg",
]);

interface VerifierOptions {
  /** Resolve the issuer key from the credential's `iss`. */
  resolveIssuerKey: IssuerKeyResolver;
  /** If set, the credential's `iss` must equal this. */
  expectedIssuer?: string;
}

class SdJwtVcVerifier implements VerifiableCredentialVerifier {
  constructor(private readonly opts: VerifierOptions) {}

  async verifyPresentation(input: VerifyPresentationInput): Promise<PresentationProof> {
    const violations: string[] = [];
    const subject: Record<string, unknown> = {};
    const claimsDisclosed: string[] = [];
    let issuer: string | undefined;
    let holderBound = false;
    let nonceBound = false;
    let paymentApproved: unknown;

    try {
      const compact = unwrapVpToken(input.vpToken);
      issuer = readIssuer(compact);
      if (this.opts.expectedIssuer && issuer !== this.opts.expectedIssuer) {
        throw new Error(`untrusted issuer ${issuer} (expected ${this.opts.expectedIssuer})`);
      }

      const key = await this.opts.resolveIssuerKey(issuer);
      const issuerVerifier = await jwkVerifier(key);

      const sdjwt = await createSdJwtVc({ issuerVerifier });
      const res = await sdjwt.verify(compact, {
        keyBindingNonce: input.nonce,
        ...(input.requiredClaims ? { requiredClaimKeys: input.requiredClaims } : {}),
      });

      const payload = res.payload as Record<string, unknown>;
      holderBound = Boolean(payload.cnf);
      nonceBound = res.kb?.payload?.nonce === input.nonce;
      paymentApproved = (res.kb?.payload as Record<string, unknown> | undefined)?.payment_mandate_v1;

      for (const [k, v] of Object.entries(payload)) {
        if (!RESERVED_CLAIMS.has(k)) {
          claimsDisclosed.push(k);
          subject[k] = v;
        }
      }

      if (!holderBound) violations.push("credential is not bound to a holder key (cnf)");
      if (!nonceBound) violations.push("key-binding nonce does not match the challenge");
    } catch (err) {
      violations.push(`presentation verification failed: ${(err as Error).message}`);
    }

    return {
      result: collect(violations),
      subject,
      claimsDisclosed,
      ...(issuer !== undefined ? { issuer } : {}),
      holderBound,
      nonceBound,
      ...(paymentApproved !== undefined ? { paymentApproved } : {}),
    };
  }
}

/** Verifier for self-issued credentials trusting a single issuer key. */
export function localVcVerifier(opts: {
  issuerId: string;
  issuerPublicJwk: Jwk;
}): VerifiableCredentialVerifier {
  return new SdJwtVcVerifier({
    expectedIssuer: opts.issuerId,
    resolveIssuerKey: async () => opts.issuerPublicJwk,
  });
}

/**
 * Unwrap a vp_token to a compact SD-JWT-VC. A compact token contains `~`
 * separators; Proof instead returns base64url(JSON { credId: [ "<compact>" ] }).
 */
export function unwrapVpToken(vpToken: string): string {
  if (vpToken.includes("~")) return vpToken; // already a compact SD-JWT-VC
  try {
    const obj = JSON.parse(b64urlToString(vpToken)) as Record<string, unknown>;
    for (const value of Object.values(obj)) {
      if (Array.isArray(value) && typeof value[0] === "string") return value[0];
      if (typeof value === "string" && value.includes("~")) return value;
    }
  } catch {
    /* not a wrapped token */
  }
  return vpToken;
}

/** Read the `iss` claim from a (possibly wrapped) vp_token without verifying. */
export function readIssuer(vpToken: string): string {
  const compact = unwrapVpToken(vpToken);
  const payloadSeg = compact.split("~")[0]?.split(".")[1];
  if (!payloadSeg) throw new Error("malformed vp_token: missing JWT payload");
  const iss = (JSON.parse(b64urlToString(payloadSeg)) as { iss?: string }).iss;
  if (!iss) throw new Error("vp_token has no issuer (iss)");
  return iss;
}

/** Build an @sd-jwt Verifier from a public JWK (ES256). */
async function jwkVerifier(jwk: Jwk): Promise<Verifier> {
  const { ES256 } = await import("@owf/crypto");
  const v = await ES256.getVerifier(jwk);
  return (data, sig) => v(data, sig);
}

function b64urlToString(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  if (typeof atob === "function") return atob(b64);
  return Buffer.from(b64, "base64").toString("binary");
}
