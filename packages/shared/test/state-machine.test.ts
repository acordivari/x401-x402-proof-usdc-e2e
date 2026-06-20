import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  IllegalTransitionError,
  isTerminal,
  nextStates,
  ORDER_STATES,
  type OrderState,
} from "../src/state-machine.ts";

describe("order state machine", () => {
  it("permits the happy-path lifecycle", () => {
    const path: OrderState[] = [
      "CREATED",
      "QUOTED",
      "AUTHORIZED",
      "SETTLING",
      "SETTLED",
      "REFUNDED",
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it("rejects skipping straight from CREATED to SETTLED", () => {
    expect(canTransition("CREATED", "SETTLED")).toBe(false);
    expect(() => assertTransition("CREATED", "SETTLED")).toThrow(
      IllegalTransitionError,
    );
  });

  it("never allows leaving a terminal state", () => {
    for (const terminal of ["FAILED", "EXPIRED", "REFUNDED"] as const) {
      expect(isTerminal(terminal)).toBe(true);
      for (const to of ORDER_STATES) {
        expect(canTransition(terminal, to)).toBe(false);
      }
    }
  });

  it("cannot re-settle: SETTLED only moves to REFUNDED", () => {
    expect(nextStates("SETTLED")).toEqual(["REFUNDED"]);
    expect(canTransition("SETTLED", "SETTLING")).toBe(false);
    expect(canTransition("SETTLED", "SETTLED")).toBe(false);
  });

  it("allows failure from AUTHORIZED and SETTLING only", () => {
    expect(canTransition("AUTHORIZED", "FAILED")).toBe(true);
    expect(canTransition("SETTLING", "FAILED")).toBe(true);
    expect(canTransition("QUOTED", "FAILED")).toBe(false);
  });

  it("assertTransition returns the next state on success", () => {
    expect(assertTransition("QUOTED", "AUTHORIZED")).toBe("AUTHORIZED");
  });
});
