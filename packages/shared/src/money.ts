/**
 * USDC amount helpers. USDC has 6 decimals; we always move amounts around as
 * bigint atomic units internally and only format to a decimal string at the
 * edges. Keeping this in one place avoids float rounding bugs leaking into
 * payment math (DRY: imported by validation, merchant, and agent).
 */
import { USDC_DECIMALS } from "./constants.ts";

const SCALE = 10n ** BigInt(USDC_DECIMALS);

/** Strip a leading "$" and surrounding whitespace, e.g. "$1.50" -> "1.50". */
export function stripCurrency(input: string): string {
  return input.trim().replace(/^\$/, "").trim();
}

/**
 * Parse a human decimal amount ("1.50", "$1.50", "0.25") into atomic USDC
 * units (1.50 -> 1_500_000n). Rejects malformed input and more precision than
 * USDC supports, rather than silently truncating money.
 */
export function dollarsToAtomic(amount: string | number): bigint {
  const raw = stripCurrency(typeof amount === "number" ? amount.toString() : amount);

  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`Invalid USDC amount: "${amount}"`);
  }

  const parts = raw.split(".");
  const whole = parts[0] ?? "0";
  const fraction = parts[1] ?? "";
  if (fraction.length > USDC_DECIMALS) {
    throw new Error(
      `USDC supports at most ${USDC_DECIMALS} decimal places, got "${amount}"`,
    );
  }

  const paddedFraction = fraction.padEnd(USDC_DECIMALS, "0");
  return BigInt(whole) * SCALE + BigInt(paddedFraction);
}

/** Format atomic USDC units back to a decimal string, e.g. 1_500_000n -> "1.50". */
export function atomicToDollars(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / SCALE;
  const fraction = (abs % SCALE).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  const body = fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
  return negative ? `-${body}` : body;
}

/** Sum a list of atomic line-item amounts. */
export function sumAtomic(amounts: readonly bigint[]): bigint {
  return amounts.reduce((acc, n) => acc + n, 0n);
}
