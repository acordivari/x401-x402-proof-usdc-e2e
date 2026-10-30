/**
 * Public surface of the verifiable-credentials (x401 + Proof) seam.
 *
 * Layers:
 *   - crypto / issuer / wallet : SD-JWT-VC issue, hold, selective-disclose
 *   - dcql                     : build/evaluate DCQL credential queries
 *   - transaction-data         : payment-mandate binding (the 401↔402 join)
 *   - verifier                 : VerifiableCredentialVerifier seam (local)
 *   - proof-sdk                : live Proof verify + hosted-request URL via
 *                                @proof.com/proof-vc-server
 *   - x401                     : @proof.com/x401-node wire wrappers + end-to-end
 *                                presentation verification
 *
 * July (x401 0.2 over a hosted redirect, sealed-challenge binding) and latest
 * (signed DC API requests, Proof's current templates and verifier enrollment)
 * live side by side; the `*-v1` / `x401-verifier-v1` modules are the latter.
 */
export * from "./crypto.ts";
export * from "./proof-credential.ts";
export * from "./transaction-data.ts";
export * from "./dcql.ts";
export * from "./issuer.ts";
export * from "./wallet.ts";
export * from "./types.ts";
export * from "./verifier.ts";
export * from "./x401.ts";
export * from "./proof-sdk.ts";

// --- latest (Oct 2026) x401 stack: signed DC API requests, CIMD client ids,
//     ProofCredentialV1, Sign Transactions templates, detached x402-paid
//     signatures, Delegate Authority. The July modules above stay untouched.
export * from "./proof-credential-v1.ts";
export * from "./templates.ts";
export * from "./nonce-store.ts";
export * from "./client-metadata.ts";
export * from "./dc-api-request.ts";
export * from "./jws.ts";
export * from "./wallet-v1.ts";
export * from "./issuer-v1.ts";
export * from "./detached-signatures.ts";
export * from "./verifier-v1.ts";
export * from "./delegation.ts";
export * from "./x401-verifier-v1.ts";
export * from "./x401-agent-v1.ts";
export * from "./proof-sdk-v1.ts";

import { localVcVerifier } from "./verifier.ts";
import { proofSdkVcVerifier, type ProofSdkVerifierOptions } from "./proof-sdk.ts";
import type { VerifiableCredentialVerifier } from "./types.ts";
import type { Jwk } from "./crypto.ts";

export type ProofMode = "local" | "live";

export interface VcVerifierConfig {
  mode: ProofMode;
  /** local mode: the trusted self-issuer id + public key. */
  local?: { issuerId: string; issuerPublicJwk: Jwk };
  /** live mode: official Proof SDK verification (`verifyVPToken`). */
  proof?: {
    /** SDK trust store ("development" | "production"). */
    trustRoot?: ProofSdkVerifierOptions["trustRoot"];
    /** Extra SDK init (clientId/secret/callbackUri) when this process also builds requests. */
    sdkInit?: ProofSdkVerifierOptions["init"];
  };
}

/**
 * Select the VC verifier from config (`PROOF_MODE`), mirroring
 * `buildFacilitator` and `localVerifier|auth0Verifier`. Callers depend only on
 * the interface: live mode is the official Proof SDK verifier, pinned to
 * Proof's committed trust store.
 */
export function createVcVerifier(config: VcVerifierConfig): VerifiableCredentialVerifier {
  if (config.mode === "live") {
    const proof = config.proof ?? {};
    return proofSdkVcVerifier({
      ...(proof.trustRoot !== undefined ? { trustRoot: proof.trustRoot } : {}),
      ...(proof.sdkInit !== undefined ? { init: proof.sdkInit } : {}),
    });
  }
  if (!config.local) throw new Error("local VC verifier requires { issuerId, issuerPublicJwk }");
  return localVcVerifier(config.local);
}
export * from "./demo-wallet.ts";
