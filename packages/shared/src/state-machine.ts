/**
 * Order lifecycle state machine. Every order transition goes through here so
 * the system can never reach a corrupt or double-settled state: only legal
 * transitions are permitted, and terminal states are dead-ends.
 *
 *   CREATED ─▶ QUOTED ─▶ AUTHORIZED ─▶ SETTLING ─▶ SETTLED ─▶ REFUNDED
 *      │         │            │            │
 *      └─────────┴────────────┴──▶ EXPIRED │
 *                             └──▶ FAILED ◀┘
 *
 * Retries do NOT move an order out of SETTLING — the settle call is retried
 * idempotently while the order stays leased in SETTLING (see merchant/settle).
 */

export const ORDER_STATES = [
  "CREATED",
  "QUOTED",
  "AUTHORIZED",
  "SETTLING",
  "SETTLED",
  "FAILED",
  "EXPIRED",
  "REFUNDED",
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

const TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  CREATED: ["QUOTED", "EXPIRED"],
  QUOTED: ["AUTHORIZED", "EXPIRED"],
  AUTHORIZED: ["SETTLING", "EXPIRED", "FAILED"],
  SETTLING: ["SETTLED", "FAILED"],
  SETTLED: ["REFUNDED"],
  FAILED: [],
  EXPIRED: [],
  REFUNDED: [],
};

/** Terminal states have no outgoing transitions. */
export function isTerminal(state: OrderState): boolean {
  return TRANSITIONS[state].length === 0;
}

export function canTransition(from: OrderState, to: OrderState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: OrderState,
    readonly to: OrderState,
  ) {
    super(`Illegal order transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

/**
 * Assert a transition is legal and return the next state. Throwing here is the
 * guard that prevents callers from corrupting order state.
 */
export function assertTransition(from: OrderState, to: OrderState): OrderState {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
  return to;
}

/** Legal next states from a given state (useful for UIs and tests). */
export function nextStates(from: OrderState): readonly OrderState[] {
  return TRANSITIONS[from];
}
