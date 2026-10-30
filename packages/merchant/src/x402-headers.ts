/**
 * One decoder for the inbound x402 payment header, shared by the order ledger
 * and both gates. Having a single parser means a header-format change can
 * never update one reader and silently leave the other returning empty (which
 * would make a paid request look unpaid and bypass the gate).
 *
 * It reads EXACTLY the header the x402 middleware verifies — `PAYMENT-SIGNATURE`
 * first, the legacy `X-PAYMENT` only in its absence — and flags a request that
 * carries a payment header it cannot fully decode, or two different ones. A
 * gate must refuse those rather than treat them as unpaid: otherwise a decoy
 * header blinds the gate while x402 verifies and settles the real one.
 */
import type { Request } from "express";

export interface PaymentAuthorization {
  from?: string;
  to?: string;
  value?: string;
  nonce?: string;
  /** Some payment header was sent. */
  present: boolean;
  /** It decoded to a complete EIP-3009 authorization (from, to, value, nonce). */
  complete: boolean;
}

const NONE: PaymentAuthorization = { present: false, complete: false };

/** Decode the EIP-3009 authorization from the request's x402 payment header. */
export function decodePaymentAuthorization(req: Request): PaymentAuthorization {
  const signature = req.header("payment-signature");
  const legacy = req.header("x-payment");
  if (signature && legacy && signature !== legacy) return { present: true, complete: false };
  const header = signature ?? legacy;
  if (!header) return NONE;
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    const auth = decoded?.payload?.authorization;
    const out = {
      from: typeof auth?.from === "string" ? auth.from : undefined,
      to: typeof auth?.to === "string" ? auth.to : undefined,
      value: typeof auth?.value === "string" ? auth.value : undefined,
      nonce: typeof auth?.nonce === "string" ? auth.nonce : undefined,
    };
    return {
      ...Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)),
      present: true,
      complete: Boolean(out.from && out.to && out.value && out.nonce),
    };
  } catch {
    return { present: true, complete: false };
  }
}

/**
 * The sku a gated route addresses, or undefined. Only the exact canonical form
 * `/<sku>` counts. Express and the x402 route matcher are both lenient
 * (trailing slash, percent-encoding, case), so a gate that waved anything else
 * through with `next()` would let a variant spelling reach a paywall that still
 * matches it — and the fulfilment route — with the gate never having run.
 */
export function canonicalSku(path: string): string | undefined {
  const m = /^\/([a-z0-9][a-z0-9-]*)$/.exec(path);
  return m?.[1];
}
