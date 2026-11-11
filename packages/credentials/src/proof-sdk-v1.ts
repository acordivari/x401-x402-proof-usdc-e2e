/**
 * Live Proof for the latest x401 flow, on `@proof.com/proof-vc-server` ≥ 0.6:
 *
 *   - `proofRequestSigner`        : `createClient({ useSecuredAuthorizationRequest })
 *                                   .signedDcApiRequest(...)` — the signed DC API
 *                                   request a PROOF-REQUEST carries
 *   - `proofPresentationVerifierV1`: `createVerifier({ environment, clientId,
 *                                   privateKeyFactory, fetch }).verifyVPToken`
 *                                   — chain to Proof's roots, `iss` pinned to the
 *                                   environment, `aud` checked, and detached
 *                                   signatures fetched (and paid for over x402
 *                                   when `fetch` can pay) transparently
 *
 * Server-only (Node trust store, the verifier's private key), so this is in the
 * node barrel and never the browser one.
 */
import { X509Certificate } from "node:crypto";
import { createClient, createVerifier, type ProofCredential, type TransactionData } from "@proof.com/proof-vc-server";
import type { JWK } from "jose";
import { collect } from "@agentic-payments/shared";
import type { DcApiRequestSigner } from "./dc-api-request.ts";
import { SIGNATURES_PATH, readPaymentResponse, type SignaturePayment } from "./detached-signatures.ts";
import { REGISTERED_CLAIMS, type PresentationVerifierV1, type VerifiedPresentationV1 } from "./verifier-v1.ts";
import { DETACHED_SIGNATURE_HEADER } from "./wallet-v1.ts";
import type { Jwk } from "./crypto.ts";

export type ProofEnvironment = "sandbox" | "production";

/** Proof's presentation endpoint — the `aud` of a request object signed for Proof. */
export const proofPresentationAudience = (env: ProofEnvironment): string =>
  `${env === "production" ? "https://api.proof.com" : "https://api.fairfax.proof.com"}/verifiable-credentials/v1/presentation`;

export function proofRequestSigner(opts: {
  environment: ProofEnvironment;
  clientId: string;
  privateJwk: JWK;
}): DcApiRequestSigner {
  const client = createClient({
    environment: opts.environment,
    clientId: opts.clientId,
    useSecuredAuthorizationRequest: true,
    privateKeyFactory: () => opts.privateJwk,
  });
  return {
    clientId: opts.clientId,
    audience: proofPresentationAudience(opts.environment),
    // The SDK's DC API helper binds ONE transaction_data value per request.
    maxTransactionData: 1,
    async signedDcApiRequest(p) {
      const [first, ...rest] = p.transactionData ?? [];
      if (rest.length) throw new Error("the Proof SDK signs one transaction_data value per DC API request");
      return client.signedDcApiRequest({
        scope: p.scope,
        nonce: p.nonce,
        expectedOrigins: p.expectedOrigins,
        ...(p.state !== undefined ? { state: p.state } : {}),
        ...(p.loginHint !== undefined ? { loginHint: p.loginHint } : {}),
        ...(first ? { transactionData: first as TransactionData } : {}),
      });
    },
  };
}

export function proofPresentationVerifierV1(opts: {
  environment: ProofEnvironment;
  clientId: string;
  privateJwk: JWK;
  /** x402-paying fetch for detached signatures; plain fetch => Proof bills the account. */
  fetch?: typeof fetch;
}): PresentationVerifierV1 {
  const trustAnchor = `Proof ${opts.environment === "production" ? "Root CA R1" : "Development Root CA"} (committed trust store)`;
  return {
    trustAnchor,
    async verifyVpToken({ encodedVpToken, aud }) {
      const signaturePayments: SignaturePayment[] = [];
      const base = opts.fetch ?? fetch;
      // Per-call recorder so the UI can show what this verification paid for.
      const recordingFetch: typeof fetch = async (input, init) => {
        const res = await base(input, init);
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith(SIGNATURES_PATH) && res.status === 200) {
          const paid = readPaymentResponse(res.headers);
          let recordId = "";
          try { recordId = String(JSON.parse(String(init?.body ?? "{}")).id ?? ""); } catch { /* best effort */ }
          if (paid) signaturePayments.push({ recordId, ...paid });
        }
        return res;
      };
      const verifier = createVerifier({
        environment: opts.environment,
        clientId: opts.clientId,
        privateKeyFactory: () => opts.privateJwk,
        fetch: recordingFetch,
      });
      try {
        const vpt = await verifier.verifyVPToken({ encodedVPToken: encodedVpToken, aud });
        const presentations: VerifiedPresentationV1[] = [];
        const violations: string[] = [];
        for (const [credentialQueryId, creds] of Object.entries(vpt)) {
          for (const cred of creds) {
            // Unknown vct is only a warning since SDK 0.5 — keep it a refusal.
            if (cred.credentialType() !== "ProofCredentialV1") {
              violations.push(`${credentialQueryId}: unexpected credential type ${cred.credentialType()}`);
              continue;
            }
            presentations.push(mapCredential(credentialQueryId, cred, trustAnchor));
          }
        }
        if (presentations.length === 0 && violations.length === 0) violations.push("vp_token carried no presentations");
        return { result: collect(violations), presentations, signaturePayments };
      } catch (err) {
        return { result: collect([`presentation verification failed: ${(err as Error).message}`]), presentations: [], signaturePayments };
      }
    },
  };
}

function mapCredential(credentialQueryId: string, cred: ProofCredential, trustAnchor: string): VerifiedPresentationV1 {
  const claims = cred.getClaims();
  const sd = cred.getSDJWT() as {
    jwt?: { header?: Record<string, unknown> };
    kbJwt?: { header?: Record<string, unknown>; payload?: Record<string, unknown> };
  };
  const kbPayload = sd.kbJwt?.payload ?? {};
  const x5c = sd.jwt?.header?.x5c;
  let issuerCert: VerifiedPresentationV1["issuerCert"];
  if (Array.isArray(x5c) && typeof x5c[0] === "string") {
    try {
      const c = new X509Certificate(Buffer.from(x5c[0], "base64"));
      issuerCert = { subject: c.subject, issuer: c.issuer };
    } catch { /* display only */ }
  }
  return {
    credentialQueryId,
    credentialType: cred.credentialType(),
    issuer: String(claims.iss),
    vct: String(claims.vct),
    claims: Object.fromEntries(Object.entries(claims).filter(([k]) => !REGISTERED_CLAIMS.has(k))),
    nonce: cred.getNonce() ?? "",
    aud: String(kbPayload.aud ?? ""),
    iat: Number(kbPayload.iat ?? 0),
    kbPayload,
    holderJwk: ((claims.cnf as { jwk?: Jwk } | undefined)?.jwk ?? {}) as Jwk,
    detachedSignatures: Boolean(sd.kbJwt?.header?.[DETACHED_SIGNATURE_HEADER]),
    trustAnchor,
    ...(issuerCert ? { issuerCert } : {}),
  };
}

/** Base API host per environment. */
export const proofApiBase = (env: ProofEnvironment): string =>
  env === "production" ? "https://api.proof.com" : "https://api.fairfax.proof.com";

/** Proof's agents trust list URL — listed in a CIMD's redirect_uris to admit Proof's trusted agents. */
export const proofAgentsTrustList = (env: ProofEnvironment): string => `${proofApiBase(env)}/.well-known/agents-trust-list`;
