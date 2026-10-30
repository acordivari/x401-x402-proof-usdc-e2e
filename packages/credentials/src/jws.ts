/**
 * Minimal compact-JWS helpers on @owf/crypto (WebCrypto), for the JWTs we
 * build by hand: Key Binding JWTs that carry template claims or a detached-
 * signature `crit` header, and the delegation chain's L2/L3 links. Building
 * them here rather than through @sd-jwt keeps full control of the header,
 * which @sd-jwt fixes to `{ typ, alg }`. Browser-safe.
 */
import { ES256 } from "@owf/crypto";
import { base64urlEncode } from "@owf/identity-common";
import type { Jwk } from "./crypto.ts";

export function b64urlJson(value: unknown): string {
  return base64urlEncode(JSON.stringify(value));
}

export function b64urlDecodeToString(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function decodeJwsPart<T = Record<string, unknown>>(segment: string): T {
  return JSON.parse(b64urlDecodeToString(segment)) as T;
}

/** Split a compact JWS into decoded header/payload plus the raw segments. */
export function parseCompactJws(jws: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: string;
} {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new Error("not a compact JWS");
  const [h, p, s] = parts as [string, string, string];
  return { header: decodeJwsPart(h), payload: decodeJwsPart(p), signingInput: `${h}.${p}`, signature: s };
}

/** Sign `header.payload` with an ES256 private JWK. */
export async function signCompactJws(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateJwk: Jwk,
): Promise<string> {
  const signingInput = `${b64urlJson({ ...header, alg: "ES256" })}.${b64urlJson(payload)}`;
  const sign = await ES256.getSigner(privateJwk);
  return `${signingInput}.${await sign(signingInput)}`;
}

/** Verify an ES256 compact JWS against a public JWK; returns the decoded parts. */
export async function verifyCompactJws(jws: string, publicJwk: Jwk): Promise<{
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}> {
  const { header, payload, signingInput, signature } = parseCompactJws(jws);
  if (header.alg !== "ES256") throw new Error(`unsupported alg ${String(header.alg)}`);
  if (!signature) throw new Error("JWS has no signature (detached?)");
  const verify = await ES256.getVerifier(publicJwk);
  if (!(await verify(signingInput, signature))) throw new Error("JWS signature is invalid");
  return { header, payload };
}
