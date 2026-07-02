/**
 * Spend guard for paying EXTERNAL x402 resources. Two layers, same rules:
 *
 *  1. `evaluateQuote` — preflight: human-readable verdict per quote, used by
 *     the CLI to show why an option is (un)acceptable before anything signs.
 *  2. `createSpendGuardPolicy` — enforcement: an @x402 PaymentPolicy injected
 *     into the paying client, so the SAME rules run again on the terms the
 *     server presents at payment time. A merchant that changes price, payee,
 *     asset, or network between preflight and retry is filtered to zero
 *     options and the client refuses to sign (fail-closed).
 *
 * Payments here are irreversible push payments on a public chain: the guard —
 * not the prompt, not the merchant — is the authorization boundary.
 */
import type { PaymentPolicy } from "@x402/fetch";
import {
  ExternalPaymentRequirements,
  atomicToDollars,
  collect,
  type NetworkConfig,
  type ValidationResult,
} from "@agentic-payments/shared";

export interface SpendGuardConfig {
  /** The single network this run is allowed to pay on. */
  network: NetworkConfig;
  /** Hard per-call price ceiling in atomic USDC units. */
  maxPerCallAtomic: bigint;
  /**
   * Recipients we may pay. When set (the buy flow pins it to the preflighted
   * quote's payTo), a payee swap at payment time is refused.
   */
  payToAllowlist?: readonly `0x${string}`[];
}

export function evaluateQuote(
  quote: ExternalPaymentRequirements,
  cfg: SpendGuardConfig,
): ValidationResult {
  const price = BigInt(quote.amount);
  return collect([
    quote.scheme === "exact"
      ? null
      : `scheme "${quote.scheme}" not supported (exact only)`,
    quote.network === cfg.network.caip2
      ? null
      : `network "${quote.network}" is not the allowed ${cfg.network.caip2} (${cfg.network.name})`,
    quote.asset === cfg.network.usdcAddress
      ? null
      : `asset ${quote.asset} is not USDC on ${cfg.network.name}`,
    price <= cfg.maxPerCallAtomic
      ? null
      : `price ${atomicToDollars(price)} USDC exceeds the per-call cap ${atomicToDollars(cfg.maxPerCallAtomic)} USDC`,
    !cfg.payToAllowlist || cfg.payToAllowlist.includes(quote.payTo)
      ? null
      : `payTo ${quote.payTo} is not on the recipient allowlist`,
  ]);
}

/**
 * Build the in-path policy from the same config. Anything that fails to parse
 * as a recognizable payment option is excluded (fail-closed), not passed
 * through.
 */
export function createSpendGuardPolicy(cfg: SpendGuardConfig): PaymentPolicy {
  return (_x402Version, paymentRequirements) =>
    paymentRequirements.filter((raw) => {
      const parsed = ExternalPaymentRequirements.safeParse(raw);
      return parsed.success && evaluateQuote(parsed.data, cfg).ok;
    });
}
