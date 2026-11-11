/**
 * Live Proof path for the July flows, built on the official Proof VC SDK
 * (`@proof.com/proof-vc-server`, which re-exports `@proof.com/proof-vc-common`).
 * Two server-side capabilities:
 *
 *   - `proofSdkVcVerifier()` : a `VerifiableCredentialVerifier` that delegates
 *     to the SDK's `createVerifier({ environment }).verifyVPToken`. The SDK
 *     decodes the `vp_token` envelope, pins `iss` to the environment's issuer,
 *     verifies each SD-JWT-VC's x5c chain against Proof's committed trust store
 *     (the store follows the environment since 0.5), and verifies the holder
 *     KB-JWT signature. The SDK does NOT compare the OID4VP nonce itself — it
 *     exposes it via `ProofCredential.getNonce()` — so the nonce↔challenge
 *     equality check in this adapter is the load-bearing, fail-closed replay gate.
 *   - `buildProofSdkAuthorizeUrl()` : builds the hosted OID4VP authorize URL
 *     via the SDK's server client (with Pushed Authorization Requests, so the
 *     client secret never leaves the server and the payment-mandate URL stays
 *     small).
 *
 * The latest flows (signed DC API requests, CIMD client ids, detached
 * signatures) live in `proof-sdk-v1.ts`; this file only keeps the July wiring
 * running on the current SDK.
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
  type Verifier,
} from "@proof.com/proof-vc-server";
import { collect } from "@agentic-payments/shared";
import { PROOF_BASIC_SCOPE, PROOF_CREDENTIAL_ID } from "./proof-credential.ts";
import type {
  PresentationProof,
  VerifiableCredentialVerifier,
  VerifyPresentationInput,
} from "./types.ts";

/**
 * Which committed Proof trust store to pin to. The SDK selected this directly
 * through 0.3.x; since 0.6 it derives the store from the environment
 * (`sandbox` → development roots, `production` → production roots) and also
 * pins `iss` to that environment's issuer. The July flows keep speaking in
 * trust roots, so the mapping lives here, in one place.
 */
export type TrustRoot = "development" | "production";
export const environmentForTrustRoot = (t: TrustRoot): "sandbox" | "production" =>
  t === "production" ? "production" : "sandbox";

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
/**
 * The trust store the verifier actually pinned to. Tracked here rather than read
 * back from a caller's options because config is first-config-wins: a later
 * `proofSdkVcVerifier({ trustRoot })` does NOT rebuild the verifier, so its
 * argument would misreport which store is in force.
 */
let sdkTrustRoot: TrustRoot | undefined;
export function configureProofSdk(params: ProofSdkConfig): void {
  if (sdkVerifier) return;
  sdkTrustRoot = params.trustRoot ?? "development";
  sdkVerifier = createVerifier({ environment: environmentForTrustRoot(sdkTrustRoot) });
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
      let issuerCert: { subject?: string; issuer?: string; trustAnchor?: string } | undefined;

      try {
        if (!sdkVerifier) throw new Error("Proof SDK verifier not configured");
        const vpt = await sdkVerifier.verifyVPToken({ encodedVPToken: input.vpToken });
        const cred = vpt[PROOF_CREDENTIAL_ID]?.[0];
        if (!cred) throw new Error(`vp_token carried no '${PROOF_CREDENTIAL_ID}' credential`);
        // Since 0.5 the SDK only WARNS on an unknown vct and hands it back as a
        // DefaultProofCredential. Through 0.3 that was a hard failure, and the
        // adapter keeps it one: a credential type we did not ask for is not
        // the identity we are about to bind a mandate to.
        if (cred.credentialType() !== "ProofCredentialV1") {
          throw new Error(`unexpected credential type ${cred.credentialType()} (want ProofCredentialV1)`);
        }

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
        // challenge is on us (the SDK exposes it via getNonce()). A mismatch is a
        // replayed or cross-session presentation → hard violation.
        nonceBound = cred.getNonce() === input.nonce;

        // When a payment-mandate transaction_data was presented, the KB-JWT
        // also carries the holder-approved payment.
        const decoded = cred.getSDJWT() as {
          kbJwt?: { payload?: Record<string, unknown> };
          jwt?: { header?: Record<string, unknown> };
        };
        paymentApproved = decoded.kbJwt?.payload?.payment_mandate_v1;
        issuerCert = leafCertSummary(decoded.jwt?.header?.x5c, sdkTrustRoot);

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

/**
 * Summarize the leaf x5c certificate (subject/issuer) for display, best-effort.
 *
 * `trustAnchor` records WHICH committed trust store the chain was pinned to. It
 * is only meaningful because this is reached solely after `verifyVPToken`
 * resolved: the SDK verifies the x5c chain against that store and throws
 * otherwise, so reaching here IS the chain having verified. The SDK exposes the
 * store as a "development" | "production" selector rather than the root
 * certificate, so that selector is the most specific thing we can honestly name.
 */
function leafCertSummary(
  x5c: unknown,
  trustRoot: TrustRoot | undefined,
): { subject?: string; issuer?: string; trustAnchor?: string } | undefined {
  if (!Array.isArray(x5c) || typeof x5c[0] !== "string") return undefined;
  try {
    const cert = new X509Certificate(Buffer.from(x5c[0], "base64"));
    return {
      subject: cert.subject,
      issuer: cert.issuer,
      ...(trustRoot !== undefined
        ? { trustAnchor: `Proof committed trust store (${trustRoot})` }
        : {}),
    };
  } catch {
    return undefined;
  }
}
