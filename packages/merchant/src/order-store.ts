/**
 * Order ledger. Every state change goes through the shared state machine, so
 * an order can never reach an illegal/corrupt state. Idempotency keys let a
 * retried *checkout request* map back to the same order instead of creating a
 * duplicate or re-charging.
 *
 * Implemented in-memory behind an interface; a SQLite-backed store can be
 * dropped in later without touching callers (same seam as PaymentSigner /
 * FacilitatorClient).
 */
import {
  assertTransition,
  type OrderState,
} from "@agentic-payments/shared";

export interface OrderRecord {
  id: string;
  sku: string;
  amount: string; // atomic USDC
  payTo: string;
  state: OrderState;
  idempotencyKey?: string;
  paymentNonce?: string; // EIP-3009 nonce, once a payment is attached
  txHash?: string;
  createdAt: number;
  updatedAt: number;
  history: Array<{ state: OrderState; at: number }>;
}

export interface CreateOrderInput {
  id: string;
  sku: string;
  amount: string;
  payTo: string;
  idempotencyKey?: string;
}

export interface OrderStore {
  create(input: CreateOrderInput): OrderRecord;
  get(id: string): OrderRecord | undefined;
  findByIdempotencyKey(key: string): OrderRecord | undefined;
  transition(id: string, to: OrderState): OrderRecord;
  attachPayment(id: string, payment: { nonce: string; txHash?: string }): OrderRecord;
  all(): OrderRecord[];
}

export class MemoryOrderStore implements OrderStore {
  private readonly orders = new Map<string, OrderRecord>();
  private readonly byIdempotencyKey = new Map<string, string>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  create(input: CreateOrderInput): OrderRecord {
    if (this.orders.has(input.id)) {
      throw new Error(`Order ${input.id} already exists`);
    }
    if (input.idempotencyKey && this.byIdempotencyKey.has(input.idempotencyKey)) {
      throw new Error(`Idempotency key already used: ${input.idempotencyKey}`);
    }
    const t = this.now();
    const record: OrderRecord = {
      id: input.id,
      sku: input.sku,
      amount: input.amount,
      payTo: input.payTo,
      state: "CREATED",
      idempotencyKey: input.idempotencyKey,
      createdAt: t,
      updatedAt: t,
      history: [{ state: "CREATED", at: t }],
    };
    this.orders.set(record.id, record);
    if (input.idempotencyKey) {
      this.byIdempotencyKey.set(input.idempotencyKey, record.id);
    }
    return { ...record };
  }

  get(id: string): OrderRecord | undefined {
    const r = this.orders.get(id);
    return r ? { ...r } : undefined;
  }

  findByIdempotencyKey(key: string): OrderRecord | undefined {
    const id = this.byIdempotencyKey.get(key);
    return id ? this.get(id) : undefined;
  }

  transition(id: string, to: OrderState): OrderRecord {
    const record = this.orders.get(id);
    if (!record) throw new Error(`Unknown order ${id}`);
    // Throws IllegalTransitionError on an illegal move — the corruption guard.
    assertTransition(record.state, to);
    record.state = to;
    record.updatedAt = this.now();
    record.history.push({ state: to, at: record.updatedAt });
    return { ...record };
  }

  attachPayment(id: string, payment: { nonce: string; txHash?: string }): OrderRecord {
    const record = this.orders.get(id);
    if (!record) throw new Error(`Unknown order ${id}`);
    record.paymentNonce = payment.nonce;
    if (payment.txHash) record.txHash = payment.txHash;
    record.updatedAt = this.now();
    return { ...record };
  }

  all(): OrderRecord[] {
    return [...this.orders.values()].map((r) => ({ ...r }));
  }
}
