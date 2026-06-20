/**
 * Payment-parameter validation — the gate every payment passes through before
 * the merchant asks the facilitator to settle. Pure and fully unit-testable.
 *
 * This is defense-in-depth on top of the facilitator's own verification: we
 * independently confirm the signed authorization matches what we quoted and
 * our policy, so a malformed/over-scoped payment never reaches settlement.
 */
import { ASSET_ALLOWLIST, PAYMENT_SCHEME, X402_NETWORK } from "./constants.ts";
import type { PaymentPayload, PaymentRequirements } from "./schemas.ts";
import { collect, type ValidationResult } from "./result.ts";

export interface PaymentValidationOptions {
  /** Current time in unix seconds (injected for deterministic tests). */
  nowSeconds: number;
  /** Token contracts we accept. Defaults to the USDC allowlist. */
  assetAllowlist?: readonly string[];
  /** If set, the authorization `from` must equal this agent wallet. */
  expectedFrom?: string;
}

/**
 * Validate a signed payment payload against the merchant's quoted requirements
 * and local policy. The `exact` scheme means the authorized value must equal
 * the quoted amount exactly — no more, no less.
 */
export function validatePaymentPayload(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  opts: PaymentValidationOptions,
): ValidationResult {
  const { nowSeconds } = opts;
  const allowlist = (opts.assetAllowlist ?? ASSET_ALLOWLIST).map((a) =>
    a.toLowerCase(),
  );
  const auth = payload.payload.authorization;
  const validAfter = Number(auth.validAfter);
  const validBefore = Number(auth.validBefore);

  return collect([
    requirements.scheme !== PAYMENT_SCHEME
      ? `unsupported scheme: ${requirements.scheme}`
      : null,
    requirements.network !== X402_NETWORK
      ? `requirements target wrong network: ${requirements.network}`
      : null,
    !allowlist.includes(requirements.asset.toLowerCase())
      ? `asset ${requirements.asset} is not on the allowlist`
      : null,
    auth.to !== requirements.payTo
      ? `payment recipient ${auth.to} does not match merchant ${requirements.payTo}`
      : null,
    auth.value !== requirements.amount
      ? `payment amount ${auth.value} does not equal required ${requirements.amount}`
      : null,
    BigInt(auth.value) <= 0n ? "payment amount must be positive" : null,
    nowSeconds < validAfter
      ? `authorization not yet valid (validAfter ${validAfter} > now ${nowSeconds})`
      : null,
    nowSeconds >= validBefore
      ? `authorization expired (validBefore ${validBefore} <= now ${nowSeconds})`
      : null,
    opts.expectedFrom && auth.from !== opts.expectedFrom.toLowerCase()
      ? `payer ${auth.from} is not the authorized agent wallet`
      : null,
  ]);
}

/**
 * Lightweight pre-flight the buyer runs before paying: refuse to pay for a
 * quote that targets a non-allowlisted asset/network or a zero/garbage amount.
 */
export function validateRequirementsBeforePaying(
  requirements: PaymentRequirements,
  assetAllowlist: readonly string[] = ASSET_ALLOWLIST,
): ValidationResult {
  const allowlist = assetAllowlist.map((a) => a.toLowerCase());
  return collect([
    requirements.network !== X402_NETWORK
      ? `quote targets unexpected network ${requirements.network}`
      : null,
    !allowlist.includes(requirements.asset.toLowerCase())
      ? `quote asset ${requirements.asset} is not on the allowlist`
      : null,
    BigInt(requirements.amount) <= 0n ? "quote amount must be positive" : null,
  ]);
}
