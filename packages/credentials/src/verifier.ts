/**
 * The verifiable-credentials verification seam. Two implementations behind one
 * interface (mirroring the identity/facilitator seams):
 *
 *   - localVcVerifier : verifies a self-issued SD-JWT-VC against a known trust
 *                       anchor (offline; the test/CI + offline-demo substrate)
 *   - proofVcVerifier : verifies a real Proof SD-JWT-VC presentation
 *
 * Both check the issuer signature, the holder key-binding (KB-JWT) against the
 * verifier's nonce, and surface the disclosed claims. Real Proof tokens differ
 * from our local ones in two ways we handle here:
 *   1. the vp_token is base64url(JSON { credId: [ "<sd-jwt-vc>" ] }) — a DCQL
 *      response envelope — not a bare compact SD-JWT.
 *   2. the issuer signs ES256 with an X.509 chain in the JWT `x5c` header (not a
 *      resolvable JWKS), so we take the signing key from the leaf certificate.
 */
import { X509Certificate, verify as nodeVerify } from "node:crypto";
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

/**
 * Proof's Fairfax sandbox issuing-CA fingerprint (SHA-256), pinned as the default
 * trust anchor. The leaf cert rotates, so we pin the stable intermediate ("Proof
 * Organization Authenticity Issuing CA R1 Development"). For production, pin the
 * Proof Root CA instead via trustedRootPems / PROOF_TRUSTED_CA_FILE.
 */
export const PROOF_FAIRFAX_CA_FINGERPRINTS = [
  "FB15F049E7834F72DEFE17E309E9DCF84001173AE2A0B7B3DBDA2D68DB31D247",
];

/** Normalize a SHA-256 fingerprint to uppercase hex with no separators. */
export function normalizeFingerprint(fp: string): string {
  return fp.replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
}

interface X5cTrust {
  /** Accept the chain if any cert in it matches one of these SHA-256 fingerprints. */
  fingerprints?: Set<string>;
  /** Accept the chain if its top cert is issued by (or equals) one of these roots. */
  rootPems?: X509Certificate[];
}

interface VerifierOptions {
  /** For non-x5c (local) credentials: resolve the issuer key from `iss`. */
  resolveIssuerKey?: IssuerKeyResolver;
  /** Allow taking the signing key from the JWT `x5c` header (Proof). */
  allowX5c?: boolean;
  /** If set, the credential's `iss` must equal this. */
  expectedIssuer?: string;
  /** Trust anchors for the x5c chain. When set, the chain must pin to one. */
  trust?: X5cTrust;
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
    let issuerCert: { subject?: string; issuer?: string } | undefined;

    try {
      const compact = unwrapVpToken(input.vpToken);
      const header = parseJwtHeader(compact);
      issuer = readIssuer(compact);
      if (this.opts.expectedIssuer && issuer !== this.opts.expectedIssuer) {
        throw new Error(`untrusted issuer ${issuer} (expected ${this.opts.expectedIssuer})`);
      }

      let issuerVerifier: Verifier;
      const x5c = Array.isArray(header.x5c) ? (header.x5c as string[]) : undefined;
      if (x5c && x5c.length > 0) {
        if (!this.opts.allowX5c) throw new Error("issuer x5c cert chain is not accepted by this verifier");
        const { verifier, cert } = es256VerifierFromX5c(x5c, this.opts.trust ?? {});
        issuerVerifier = verifier;
        issuerCert = cert;
      } else {
        if (!this.opts.resolveIssuerKey) throw new Error("no issuer key resolver configured");
        const key = await this.opts.resolveIssuerKey(issuer);
        issuerVerifier = await jwkVerifier(key);
      }

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
      ...(issuerCert !== undefined ? { issuerCert } : {}),
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

export interface ProofVcVerifierOptions {
  /** Require this exact issuer (e.g. https://api.fairfax.proof.com). */
  expectedIssuer?: string;
  /**
   * SHA-256 fingerprints the x5c chain must pin to. Defaults to Proof's Fairfax
   * issuing CA. Pass an empty array to accept any well-formed chain (NOT advised).
   */
  trustedCaFingerprints?: string[];
  /** PEM root certs to anchor the chain to (e.g. Proof's published root CA). */
  trustedRootPems?: string[];
}

/**
 * Verifier for live Proof credentials. Proof signs with an ES256 X.509 chain in
 * the JWT `x5c` header: we verify the leaf signature, the chain links, and that
 * the chain pins to a trusted Proof CA (by fingerprint and/or root).
 */
export function proofVcVerifier(opts: ProofVcVerifierOptions = {}): VerifiableCredentialVerifier {
  const fingerprints = new Set(
    (opts.trustedCaFingerprints ?? PROOF_FAIRFAX_CA_FINGERPRINTS).map(normalizeFingerprint),
  );
  const rootPems = (opts.trustedRootPems ?? []).map((pem) => new X509Certificate(pem));
  return new SdJwtVcVerifier({
    allowX5c: true,
    ...(opts.expectedIssuer ? { expectedIssuer: opts.expectedIssuer } : {}),
    trust: { fingerprints, rootPems },
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

function parseJwtHeader(compact: string): Record<string, unknown> {
  const headerSeg = compact.split("~")[0]?.split(".")[0];
  if (!headerSeg) throw new Error("malformed vp_token: missing JWT header");
  return JSON.parse(b64urlToString(headerSeg)) as Record<string, unknown>;
}

/**
 * Build an ES256 signature verifier from an x5c chain (leaf first). Verifies the
 * JWS against the leaf certificate's public key, checks the chain links (each
 * cert issued by the next), and — when trust anchors are configured — requires
 * the chain to pin to a trusted Proof CA (by SHA-256 fingerprint or root issuer).
 */
function es256VerifierFromX5c(
  x5c: string[],
  trust: X5cTrust,
): {
  verifier: Verifier;
  cert: { subject?: string; issuer?: string; trustAnchor?: string };
} {
  const certs = x5c.map((b) => new X509Certificate(Buffer.from(b, "base64")));
  const leaf = certs[0]!;
  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i]!.checkIssued(certs[i + 1]!)) {
      throw new Error("x5c chain is not internally consistent (broken issuer link)");
    }
  }

  let trustAnchor: string | undefined;
  const pinning = (trust.fingerprints?.size ?? 0) > 0 || (trust.rootPems?.length ?? 0) > 0;
  if (pinning) {
    for (const c of certs) {
      if (trust.fingerprints?.has(normalizeFingerprint(c.fingerprint256))) {
        trustAnchor = oneLine(c.subject);
        break;
      }
    }
    if (!trustAnchor && trust.rootPems?.length) {
      const top = certs[certs.length - 1]!;
      for (const root of trust.rootPems) {
        if (top.checkIssued(root) || normalizeFingerprint(top.fingerprint256) === normalizeFingerprint(root.fingerprint256)) {
          trustAnchor = oneLine(root.subject);
          break;
        }
      }
    }
    if (!trustAnchor) throw new Error("x5c chain does not pin to a trusted Proof CA");
  }

  const key = leaf.publicKey;
  const verifier: Verifier = (data, sig) => {
    const signature = Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return nodeVerify("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" }, signature);
  };
  return {
    verifier,
    cert: { subject: oneLine(leaf.subject), issuer: oneLine(leaf.issuer), ...(trustAnchor ? { trustAnchor } : {}) },
  };
}

function oneLine(dn: string): string {
  return dn.replace(/\s*\n\s*/g, ", ");
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
