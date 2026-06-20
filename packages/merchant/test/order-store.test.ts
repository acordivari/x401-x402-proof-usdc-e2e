import { describe, expect, it } from "vitest";
import { IllegalTransitionError } from "@agentic-payments/shared";
import { MemoryOrderStore } from "../src/order-store.ts";

function fixedClock() {
  let t = 1000;
  return () => (t += 1);
}

function newOrder(store: MemoryOrderStore, over: Partial<Parameters<MemoryOrderStore["create"]>[0]> = {}) {
  return store.create({
    id: over.id ?? "order-1",
    sku: over.sku ?? "allergy-relief-24",
    amount: over.amount ?? "1500000",
    payTo: over.payTo ?? "0x1111111111111111111111111111111111111111",
    idempotencyKey: over.idempotencyKey,
  });
}

describe("MemoryOrderStore", () => {
  it("creates an order in CREATED with history", () => {
    const store = new MemoryOrderStore(fixedClock());
    const o = newOrder(store);
    expect(o.state).toBe("CREATED");
    expect(o.history).toHaveLength(1);
  });

  it("walks the happy-path lifecycle", () => {
    const store = new MemoryOrderStore(fixedClock());
    newOrder(store);
    for (const s of ["QUOTED", "AUTHORIZED", "SETTLING", "SETTLED"] as const) {
      store.transition("order-1", s);
    }
    expect(store.get("order-1")?.state).toBe("SETTLED");
    expect(store.get("order-1")?.history.map((h) => h.state)).toEqual([
      "CREATED",
      "QUOTED",
      "AUTHORIZED",
      "SETTLING",
      "SETTLED",
    ]);
  });

  it("rejects an illegal transition (corruption guard)", () => {
    const store = new MemoryOrderStore(fixedClock());
    newOrder(store);
    expect(() => store.transition("order-1", "SETTLED")).toThrow(IllegalTransitionError);
    // order is unchanged after the rejected transition
    expect(store.get("order-1")?.state).toBe("CREATED");
  });

  it("maps an idempotency key back to the same order", () => {
    const store = new MemoryOrderStore(fixedClock());
    newOrder(store, { idempotencyKey: "key-abc" });
    expect(store.findByIdempotencyKey("key-abc")?.id).toBe("order-1");
  });

  it("refuses to reuse an idempotency key for a new order", () => {
    const store = new MemoryOrderStore(fixedClock());
    newOrder(store, { idempotencyKey: "key-abc" });
    expect(() =>
      newOrder(store, { id: "order-2", idempotencyKey: "key-abc" }),
    ).toThrow(/Idempotency key already used/);
  });

  it("attaches payment nonce + tx hash", () => {
    const store = new MemoryOrderStore(fixedClock());
    newOrder(store);
    store.attachPayment("order-1", { nonce: "0xabc", txHash: "0xdef" });
    const o = store.get("order-1");
    expect(o?.paymentNonce).toBe("0xabc");
    expect(o?.txHash).toBe("0xdef");
  });

  it("returns copies so callers cannot mutate internal state", () => {
    const store = new MemoryOrderStore(fixedClock());
    const o = newOrder(store);
    o.state = "SETTLED";
    expect(store.get("order-1")?.state).toBe("CREATED");
  });
});
