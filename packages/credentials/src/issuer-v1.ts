/**
 * Local issuer for ProofCredentialV1-SHAPED credentials: the offline stand-in
 * for Proof's issuer. Same format (SD-JWT VC, `typ: dc+sd-jwt`, ES256, holder
 * key in `cnf.jwk`), same claim names and nesting, every member selectively
 * disclosable — but under our own `iss` and a sandbox `vct`, and signed by a
 * pinned key rather than an x5c chain to Proof Root CA R1. A verifier
 * configured for Proof will refuse these, which is the point: nothing minted
 * here can pass for a Proof credential.
 */
import { createSdJwtVc, type Jwk } from "./crypto.ts";
import {
  LOCAL_CREDENTIAL_V1_VCT,
  proofCredentialV1Frame,
  type ProofCredentialV1Claims,
} from "./proof-credential-v1.ts";

export interface LocalCredentialV1IssuerOptions {
  issuerId: string;
  privateJwk: Jwk;
  vct?: string;
  /** unix seconds */
  now?: () => number;
}

export class LocalCredentialV1Issuer {
  readonly vct: string;
  constructor(private readonly opts: LocalCredentialV1IssuerOptions) {
    this.vct = opts.vct ?? LOCAL_CREDENTIAL_V1_VCT;
  }

  get issuerId(): string {
    return this.opts.issuerId;
  }

  /** Issue to a holder key. Returns issuer JWT + every disclosure, no KB-JWT. */
  async issue(claims: ProofCredentialV1Claims, holderPublicJwk: Jwk, ttlSeconds = 31_536_000): Promise<string> {
    const sdjwt = await createSdJwtVc({ issuerPrivateJwk: this.opts.privateJwk });
    const iat = this.opts.now?.() ?? Math.floor(Date.now() / 1000);
    const payload = {
      iss: this.opts.issuerId,
      vct: this.vct,
      iat,
      exp: iat + ttlSeconds,
      cnf: { jwk: holderPublicJwk },
      ...claims,
    };
    return sdjwt.issue(payload, proofCredentialV1Frame(claims) as never);
  }
}
