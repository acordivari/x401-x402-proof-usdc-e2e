/**
 * Turn a traced HTTP exchange into something a person can read: every x401 and
 * x402 header decoded, signed blobs shortened, the request object's claims
 * shown instead of its compact JWS. Display only — nothing here verifies.
 */
import { decodeDcApiRequest, decodeTxData, decodeVpToken } from "@agentic-payments/credentials";
import type { HttpExchange } from "@agentic-payments/agent";

const b64json = (s: string): unknown => {
  try {
    return JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
  } catch {
    try {
      return JSON.parse(Buffer.from(s, "base64").toString("utf8"));
    } catch {
      return undefined;
    }
  }
};

const short = (s: unknown, keep = 18): unknown =>
  typeof s === "string" && s.length > keep * 2 + 3 ? `${s.slice(0, keep)}…${s.slice(-6)}` : s;

function describeProofRequest(header: string) {
  const payload = b64json(header) as Record<string, any> | undefined;
  if (!payload) return { undecodable: true };
  const requests = payload.credential_requirements?.digital?.requests ?? [];
  return {
    ...payload,
    credential_requirements: {
      digital: {
        requests: requests.map((r: any) => {
          if (typeof r?.data?.request !== "string") return r;
          try {
            const { header: h, claims } = decodeDcApiRequest(r.data.request);
            return {
              protocol: r.protocol,
              request: {
                header: h,
                claims: { ...claims, transaction_data: (claims.transaction_data ?? []).map((t: string) => decodeTxData(t)) },
                compact: short(r.data.request, 24),
              },
            };
          } catch {
            return { protocol: r.protocol, request: short(r.data.request) };
          }
        }),
      },
    },
  };
}

function describeProofResponse(header: string) {
  const v = b64json(header) as Record<string, any> | undefined;
  if (!v) return { undecodable: true };
  if (v.token_type) return { kind: "x401 Token Object", token_type: v.token_type, access_token: short(v.access_token, 8) };
  const data = v.credential_result?.data;
  let presentations: Record<string, number> | undefined;
  try {
    const raw = data?.vp_token;
    const map = typeof raw === "string" ? decodeVpToken(raw) : (raw as Record<string, string[]>);
    presentations = Object.fromEntries(Object.entries(map).map(([k, list]) => [k, list.length]));
  } catch { /* opaque */ }
  return {
    kind: "x401 Result Artifact",
    ...(v.agent_id ? { agent_id: v.agent_id } : {}),
    ...(v.request_id ? { request_id: v.request_id } : {}),
    ...(v.credential_result ? { protocol: v.credential_result.protocol, presentations } : {}),
    ...(v.credential_result_uri ? { credential_result_uri: v.credential_result_uri } : {}),
  };
}

function describePayment(header: string) {
  const v = b64json(header) as Record<string, any> | undefined;
  const auth = v?.payload?.authorization;
  return auth
    ? { x402Version: v?.x402Version, from: auth.from, to: auth.to, value: auth.value, nonce: short(auth.nonce, 10), signature: short(v?.payload?.signature, 10) }
    : v ?? { undecodable: true };
}

function describePaymentRequired(header: string) {
  const v = b64json(header) as Record<string, any> | undefined;
  if (!v) return { undecodable: true };
  return {
    x402Version: v.x402Version,
    ...(v.error ? { error: v.error } : {}),
    accepts: (v.accepts ?? []).map((a: any) => ({ scheme: a.scheme, network: a.network, amount: a.amount, payTo: a.payTo, asset: a.asset })),
    ...(v.resource ? { resource: v.resource } : {}),
  };
}

export function describeExchange(ex: HttpExchange) {
  const decoded: Record<string, unknown> = {};
  if (ex.response["proof-request"]) decoded.proofRequest = describeProofRequest(ex.response["proof-request"]);
  if (ex.response["proof-result"]) decoded.proofResult = b64json(ex.response["proof-result"]);
  if (ex.request["proof-response"]) decoded.proofResponse = describeProofResponse(ex.request["proof-response"]);
  const pay = ex.request["payment-signature"] ?? ex.request["x-payment"];
  if (pay) decoded.payment = describePayment(pay);
  if (ex.response["payment-required"]) decoded.paymentRequired = describePaymentRequired(ex.response["payment-required"]);
  const settle = ex.response["payment-response"] ?? ex.response["x-payment-response"];
  if (settle) decoded.paymentResponse = b64json(settle);
  let path = ex.url;
  try { path = new URL(ex.url).pathname; } catch { /* keep */ }
  return {
    at: ex.at,
    method: ex.method,
    path,
    status: ex.status,
    decoded,
    ...(ex.body !== undefined ? { body: trimBody(ex.body) } : {}),
  };
}

function trimBody(body: unknown): unknown {
  if (typeof body === "string") return short(body, 60);
  if (Array.isArray(body)) return body.map(trimBody);
  if (body && typeof body === "object") {
    return Object.fromEntries(Object.entries(body as Record<string, unknown>).map(([k, v]) => [k, k === "access_token" ? short(v, 8) : trimBody(v)]));
  }
  return body;
}
