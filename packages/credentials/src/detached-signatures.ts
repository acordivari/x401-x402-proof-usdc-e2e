/**
 * Buying back a presentation's detached signatures — x401 paid for over x402.
 *
 * A verifier with no card or bank account on file at Proof receives each
 * presentation with its signature segments removed. To verify it, the
 * verifier POSTs the record id (named in the KB-JWT's `crit` header) to the
 * x401 Signatures endpoint, authenticated by a `private_key_jwt` client
 * assertion signed with its CIMD key. The endpoint answers 402 with x402
 * payment terms until the presentation is paid for, then 200 with
 * `{ issuer_signature, kb_signature }`. 409 means "not ready yet, retry".
 *
 * `httpSignatureResolver` speaks that wire exactly, against any base URL, so
 * the offline emulator and Proof itself are interchangeable behind it; give it
 * an x402-paying `fetch` and the 402 is settled transparently. The live path
 * normally lets the Proof SDK do all of this inside `verifyVPToken`.
 */
import { SignJWT, calculateJwkThumbprint, importJWK, type JWK } from "jose";
import type { DetachedSignatures } from "./wallet-v1.ts";
import { publicPart } from "./dc-api-request.ts";

export const SIGNATURES_PATH = "/verifiable-credentials/v1/x401-signatures";
export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/** One settled x402 payment for a set of signatures, as read from PAYMENT-RESPONSE. */
export interface SignaturePayment {
  recordId: string;
  /** Settlement transaction (a mock hash offline). */
  transaction?: string;
  network?: string;
  payer?: string;
  /** Atomic units, when the 402 terms were seen. */
  amount?: string;
  payTo?: string;
}

export interface SignatureResolution {
  signatures: DetachedSignatures;
  payment?: SignaturePayment;
}

/** The seam: where a verifier gets detached signatures from. */
export interface DetachedSignatureResolver {
  resolve(recordId: string): Promise<SignatureResolution>;
}

export interface HttpSignatureResolverOptions {
  /** e.g. https://api.fairfax.proof.com, or the local emulator's base. */
  baseUrl: string;
  clientId: string;
  /** The verifier's CIMD private key. */
  privateJwk: JWK;
  /** An x402-paying fetch; a plain fetch fails closed on 402. */
  fetch?: typeof fetch;
  pendingRetries?: number;
}

export function httpSignatureResolver(opts: HttpSignatureResolverOptions): DetachedSignatureResolver {
  const doFetch = opts.fetch ?? fetch;
  const url = new URL(SIGNATURES_PATH, opts.baseUrl).toString();
  return {
    async resolve(recordId) {
      const kid = await calculateJwkThumbprint(publicPart(opts.privateJwk));
      const key = await importJWK(opts.privateJwk, "ES256");
      for (let attempt = 0; ; attempt += 1) {
        const iat = Math.floor(Date.now() / 1000);
        const assertion = await new SignJWT({})
          .setProtectedHeader({ alg: "ES256", kid })
          .setIssuer(opts.clientId)
          .setSubject(opts.clientId)
          .setAudience(url)
          .setIssuedAt(iat)
          .setExpirationTime(iat + 300)
          .setJti(crypto.randomUUID())
          .sign(key);
        const res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: recordId, client_assertion_type: CLIENT_ASSERTION_TYPE, client_assertion: assertion }),
        });
        if (res.status === 409 && attempt < (opts.pendingRetries ?? 5)) {
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (res.status === 402) throw new Error("detached signatures require an x402 payment and this verifier has no paying fetch");
        if (res.status !== 200) {
          throw new Error(`detached signatures fetch failed (${res.status})${typeof body.error === "string" ? `: ${body.error}` : ""}`);
        }
        const { issuer_signature, kb_signature } = body;
        if (typeof issuer_signature !== "string" || typeof kb_signature !== "string" || !issuer_signature || !kb_signature) {
          throw new Error("detached signatures fetch returned no signatures");
        }
        const payment = readPaymentResponse(res.headers);
        return {
          signatures: { issuer_signature, kb_signature },
          ...(payment ? { payment: { recordId, ...payment } } : {}),
        };
      }
    },
  };
}

/** Decode an x402 v2 PAYMENT-RESPONSE (or legacy X-PAYMENT-RESPONSE) settle receipt. */
export function readPaymentResponse(headers: Headers): Omit<SignaturePayment, "recordId"> | undefined {
  const raw = headers.get("payment-response") ?? headers.get("x-payment-response");
  if (!raw) return undefined;
  try {
    const json = JSON.parse(atob(raw)) as Record<string, unknown>;
    return {
      ...(typeof json.transaction === "string" ? { transaction: json.transaction } : {}),
      ...(typeof json.network === "string" ? { network: json.network } : {}),
      ...(typeof json.payer === "string" ? { payer: json.payer } : {}),
    };
  } catch {
    return undefined;
  }
}
