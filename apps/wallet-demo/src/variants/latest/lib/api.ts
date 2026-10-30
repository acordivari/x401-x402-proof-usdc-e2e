/** JSON client for the orchestrator's latest-variant routes. The browser only talks to us. */
export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(
    path,
    body !== undefined
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {},
  );
  return res.json() as Promise<T>;
}

export const short = (s?: string, head = 6, tail = 4) => (s ? (s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s) : "—");
export const usd = (n: number | string | undefined) => `$${Number(n ?? 0).toFixed(2)}`;
export const atomicUsd = (atomic: string | number | undefined) => `$${(Number(atomic || 0) / 1e6).toFixed(2)}`;

/** Render a claim value: Proof nests thresholds ({"18": true}). */
export function fmtClaim(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => (typeof x === "boolean" ? `${k} ${x ? "✓" : "✗"}` : `${k}: ${String(x)}`))
      .join(" · ");
  }
  return String(v);
}

/** Flatten nested claims into dotted leaves: { age_equal_or_over: { 18: true } } → ["age_equal_or_over.18", true]. */
export function leaves(claims: Record<string, unknown>, prefix = ""): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [k, v] of Object.entries(claims ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...leaves(v as Record<string, unknown>, key));
    else out.push([key, v]);
  }
  return out;
}

export const TEMPLATE_LABEL: Record<string, string> = {
  "urn:proof:params:vc:transaction-data:payment-itemized:v1": "Itemized payment",
  "urn:proof:params:vc:transaction-data:payment-mandate:v1": "Payment mandate",
  "urn:proof:params:vc:transaction-data:session-data": "Session data",
  "urn:proof:params:vc:transaction-data:wire-instructions:v1": "Wire instructions",
};
