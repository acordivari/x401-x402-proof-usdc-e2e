import { describe, expect, it } from "vitest";
import { atomicToDollars, dollarsToAtomic, sumAtomic } from "../src/money.ts";

describe("dollarsToAtomic", () => {
  it("converts whole and fractional dollars to 6-decimal atomic units", () => {
    expect(dollarsToAtomic("1")).toBe(1_000_000n);
    expect(dollarsToAtomic("1.50")).toBe(1_500_000n);
    expect(dollarsToAtomic("0.000001")).toBe(1n);
    expect(dollarsToAtomic(0.25)).toBe(250_000n);
  });

  it("strips a leading $ and whitespace", () => {
    expect(dollarsToAtomic(" $1.50 ")).toBe(1_500_000n);
  });

  it("rejects more precision than USDC supports", () => {
    expect(() => dollarsToAtomic("1.0000001")).toThrow(/decimal places/);
  });

  it("rejects malformed amounts", () => {
    expect(() => dollarsToAtomic("abc")).toThrow(/Invalid USDC amount/);
    expect(() => dollarsToAtomic("1.2.3")).toThrow();
    expect(() => dollarsToAtomic("-1")).toThrow();
  });
});

describe("atomicToDollars", () => {
  it("round-trips with dollarsToAtomic (already-trimmed values)", () => {
    for (const v of ["0", "1", "1.5", "1.499999", "1234.000001"]) {
      expect(atomicToDollars(dollarsToAtomic(v))).toBe(v);
    }
  });

  it("formats atomic units back to trimmed decimals", () => {
    expect(atomicToDollars(1_500_000n)).toBe("1.5");
    expect(atomicToDollars(1n)).toBe("0.000001");
    expect(atomicToDollars(0n)).toBe("0");
  });
});

describe("sumAtomic", () => {
  it("sums line items", () => {
    expect(sumAtomic([1_000_000n, 500_000n, 1n])).toBe(1_500_001n);
    expect(sumAtomic([])).toBe(0n);
  });
});
