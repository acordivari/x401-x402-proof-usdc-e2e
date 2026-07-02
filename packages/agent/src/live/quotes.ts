/**
 * Preflight against an external x402 resource: request WITHOUT payment and
 * decode the 402 challenge into normalized quotes the guard can evaluate.
 * Handles the v2 wire format (base64 `PAYMENT-REQUIRED` header, JSON body
 * fallback) and normalizes legacy v1 fields (`maxAmountRequired`, friendly
 * network names) so older endpoints still preflight cleanly.
 */
import {
  ExternalPaymentRequiredResponse,
  type ExternalPaymentRequirements,
} from "@agentic-payments/shared";

/** v1 friendly network names → CAIP-2 (the v2 identifier we use everywhere). */
const V1_NETWORKS: Record<string, string> = {
  base: "eip155:8453",
  "base-sepolia": "eip155:84532",
};

export interface PreflightResult {
  status: number;
  /** Normalized payment options; empty when the response wasn't a 402. */
  quotes: ExternalPaymentRequirements[];
  /** Decoded challenge (or response body) for display/debugging. */
  raw?: unknown;
}

function normalizeAccept(accept: Record<string, unknown>): Record<string, unknown> {
  const network = typeof accept.network === "string" ? accept.network : "";
  return {
    ...accept,
    network: V1_NETWORKS[network] ?? network,
    amount: accept.amount ?? accept.maxAmountRequired,
  };
}

function decodeChallenge(payload: unknown): ExternalPaymentRequirements[] {
  const body = payload as { accepts?: unknown[] };
  if (!Array.isArray(body?.accepts)) {
    throw new Error("402 response carries no `accepts` payment options");
  }
  const normalized = {
    ...(payload as Record<string, unknown>),
    accepts: body.accepts.map((a) => normalizeAccept(a as Record<string, unknown>)),
  };
  return ExternalPaymentRequiredResponse.parse(normalized).accepts;
}

export async function preflight(
  url: string,
  init: RequestInit = {},
): Promise<PreflightResult> {
  const res = await fetch(url, init);
  if (res.status !== 402) {
    const raw = await res.text().catch(() => "");
    return { status: res.status, quotes: [], raw };
  }

  const header = res.headers.get("PAYMENT-REQUIRED");
  let payload: unknown;
  if (header) {
    payload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } else {
    payload = await res.json().catch(() => {
      throw new Error("402 response had neither a PAYMENT-REQUIRED header nor a JSON body");
    });
  }
  return { status: 402, quotes: decodeChallenge(payload), raw: payload };
}
