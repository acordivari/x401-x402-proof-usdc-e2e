/**
 * Poll a merchant's order-by-nonce endpoint until settlement reaches a
 * terminal state (SETTLED/FAILED) or attempts run out. Settlement is
 * asynchronous in x402 v2 (the merchant grants access on verify and settles
 * after the response), so every buyer — CLI or orchestrator — polls the same
 * way. Defined once here.
 */
export interface PollOrderOptions {
  /** Max polls before giving up (default 40 — generous for real chains). */
  attempts?: number;
  /** Delay between polls in ms (default 500; in-process demos use ~50). */
  delayMs?: number;
}

export async function pollOrder(
  merchantUrl: string,
  nonce: string,
  opts: PollOrderOptions = {},
): Promise<unknown> {
  const attempts = opts.attempts ?? 40;
  const delayMs = opts.delayMs ?? 500;
  for (let i = 0; i < attempts; i++) {
    const r = await fetch(`${merchantUrl}/orders/by-nonce/${nonce}`);
    if (r.ok) {
      const order = (await r.json()) as { state?: string };
      if (order.state === "SETTLED" || order.state === "FAILED") return order;
    }
    await new Promise((res) => setTimeout(res, delayMs));
  }
  return undefined;
}
