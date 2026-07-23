/**
 * Live Proof path built on the official Proof VC SDK. Since 0.3.1 the SDK is
 * split: `@proof.com/proof-vc-server` carries the verifier, transaction_data
 * and the server-side request client (and re-exports the client/DCQL half,
 * `@proof.com/proof-vc-common`). Two server-side capabilities:
 *
 *   - `proofSdkVcVerifier()` : a `VerifiableCredentialVerifier` that delegates
 *     to the SDK's `createVerifier(trustRoot).verifyVPToken`. The SDK decodes
 *     the DCQL `vp_token` envelope, verifies each SD-JWT-VC's issuer x5c chain
 *     against Proof's committed trust store (`trustRoot`, pinning Proof's
 *     actual Root CA), and verifies the holder KB-JWT signature. Since 0.3.x
 *     the SDK does NOT compare the OID4VP nonce itself — it exposes it via
 *     `ProofCredential.getNonce()` — so the nonce↔challenge equality check in
 *     this adapter is the load-bearing, fail-closed replay gate.
 *   - `buildProofSdkAuthorizeUrl()` : builds the hosted OID4VP authorize URL
 *     via the SDK's server client (with Pushed Authorization Requests, so the
 *     client secret never leaves the server and the payment-mandate URL stays
 *     small).
 *
 * Server-only (handles the client secret + Node trust store), so this lives in
 * the node barrel (`index.ts`) and NOT the browser barrel. The x401
 * challenge/binding layer (`x401.ts`) composes around this exactly as
 * `@proof.com/x401-node` prescribes.
 */
import { X509Certificate } from "node:crypto";
import {
  createClient,
  createVerifier,
  transactionData as proofTransactionData,
  type Scope,
  type ServerClientConfig,
  type ServerVCClient,
  type TransactionData,
  type TrustRoot,
  type Verifier,
} from "@proof.com/proof-vc-server";
import { collect } from "@agentic-payments/shared";
import { PROOF_BASIC_SCOPE, PROOF_CREDENTIAL_ID } from "./proof-credential.ts";
import type {
  PresentationProof,
  VerifiableCredentialVerifier,
  VerifyPresentationInput,
} from "./types.ts";

/** Re-export the SDK's transaction-data builders (payment-mandate, etc.). */
export { proofTransactionData };
export type { TransactionData as ProofSdkTransactionData };

/** JWT registered / SD-JWT-VC claims that are not user-disclosed attributes. */
const RESERVED_CLAIMS = new Set([
  "iss", "vct", "vct#integrity", "cnf", "iat", "exp", "nbf", "sub", "status", "_sd", "_sd_alg",
]);

/**
 * One flat config object mirroring the pre-split SDK's `NodeInitParams`, so
 * callers keep configuring in one place: `trustRoot` feeds the verifier, the
 * request fields feed the client.
 */
export interface ProofSdkConfig {
  trustRoot?: TrustRoot;
  environment?: ServerClientConfig["environment"];
  clientId?: string;
  clientSecret?: string;
  callbackUri?: string;
  responseMode?: ServerClientConfig["responseMode"];
  usePushedAuthorizationRequest?: boolean;
}

/**
 * First-config-wins module state (parity with the pre-split SDK's singleton,
 * which threw on re-init). The request client is only built when the request
 * config (environment/clientId/callbackUri) is present, so a verify-only
 * process needs no client credentials.
 */
let sdkVerifier: Verifier | undefined;
let sdkClient: ServerVCClient | undefined;
export function configureProofSdk(params: ProofSdkConfig): void {
  if (sdkVerifier) return;
  sdkVerifier = createVerifier({ trustRoot: params.trustRoot ?? "development" });
  if (params.environment && params.clientId && params.callbackUri) {
    sdkClient = createClient({
      environment: params.environment,
      clientId: params.clientId,
      callbackUri: params.callbackUri,
      ...(params.responseMode !== undefined ? { responseMode: params.responseMode } : {}),
      ...(params.clientSecret !== undefined ? { clientSecret: params.clientSecret } : {}),
      ...(params.usePushedAuthorizationRequest !== undefined
        ? { usePushedAuthorizationRequest: params.usePushedAuthorizationRequest }
        : {}),
    });
  }
}

export interface ProofSdkVerifierOptions {
  /** Proof trust store to pin the issuer chain to. Default: "development" (sandbox). */
  trustRoot?: TrustRoot;
  /** Extra config (clientId/secret/callbackUri) when this process also builds requests. */
  init?: Omit<ProofSdkConfig, "trustRoot">;
}

/**
 * Verify a real Proof `vp_token` via the SDK. On success the credential is fully
 * verified (issuer chain trusted, holder-bound, nonce-bound); we surface the
 * disclosed claims and the holder-approved payment for the HAM Intent.
 */
export function proofSdkVcVerifier(opts: ProofSdkVerifierOptions = {}): VerifiableCredentialVerifier {
  configureProofSdk({ trustRoot: opts.trustRoot ?? "development", ...(opts.init ?? {}) });

  return {
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
        if (!sdkVerifier) throw new Error("Proof SDK verifier not configured");
        const vpt = await sdkVerifier.verifyVPToken({ encodedVPToken: input.vpToken });
        const cred = vpt[PROOF_CREDENTIAL_ID]?.[0];
        if (!cred) throw new Error(`vp_token carried no '${PROOF_CREDENTIAL_ID}' credential`);

        const claims = cred.getClaims();
        issuer = typeof claims.iss === "string" ? claims.iss : undefined;
        holderBound = Boolean(claims.cnf);
        for (const [k, v] of Object.entries(claims)) {
          if (!RESERVED_CLAIMS.has(k)) {
            claimsDisclosed.push(k);
            subject[k] = v;
          }
        }

        // The SDK verified the KB-JWT *signature*; comparing its nonce to our
        // challenge is on us (0.3.x exposes it via getNonce()). A mismatch is a
        // replayed or cross-session presentation → hard violation.
        nonceBound = cred.getNonce() === input.nonce;

        // When a payment-mandate transaction_data was presented, the KB-JWT
        // also carries the holder-approved payment.
        const decoded = cred.getSDJWT() as {
          kbJwt?: { payload?: Record<string, unknown> };
          jwt?: { header?: Record<string, unknown> };
        };
        paymentApproved = decoded.kbJwt?.payload?.payment_mandate_v1;
        issuerCert = leafCertSummary(decoded.jwt?.header?.x5c);

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
    },
  };
}

export interface ProofSdkAuthorizeInput {
  /** The OID4VP nonce — pass the x401 challenge value so the two bind together. */
  nonce: string;
  /** The verified End-User's email (Proof's `login_hint`). */
  loginHint?: string;
  state?: string;
  scope?: string;
  /** Encoded transaction_data string, or an SDK transaction-data object. */
  transactionData?: TransactionData | string;
}

/**
 * Build the hosted Proof authorize URL via the SDK. Requires the SDK to have
 * been configured with the request config (environment/clientId/callbackUri),
 * either at construction of `proofSdkVcVerifier({ init })` or via
 * `configureProofSdk`.
 */
export async function buildProofSdkAuthorizeUrl(input: ProofSdkAuthorizeInput): Promise<string> {
  if (!sdkClient) {
    throw new Error(
      "Proof SDK request config missing — configureProofSdk needs environment + clientId + callbackUri before building authorize URLs",
    );
  }
  return sdkClient.authorizationUrl({
    scope: (input.scope ?? PROOF_BASIC_SCOPE) as Scope,
    nonce: input.nonce,
    ...(input.state !== undefined ? { state: input.state } : {}),
    ...(input.loginHint !== undefined ? { loginHint: input.loginHint } : {}),
    ...(input.transactionData !== undefined ? { transactionData: input.transactionData } : {}),
  });
}

/** Summarize the leaf x5c certificate (subject/issuer) for display, best-effort. */
function leafCertSummary(x5c: unknown): { subject?: string; issuer?: string } | undefined {
  if (!Array.isArray(x5c) || typeof x5c[0] !== "string") return undefined;
  try {
    const cert = new X509Certificate(Buffer.from(x5c[0], "base64"));
    return { subject: cert.subject, issuer: cert.issuer };
  } catch {
    return undefined;
  }
}
