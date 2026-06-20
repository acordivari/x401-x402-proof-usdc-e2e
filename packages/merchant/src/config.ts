/**
 * Merchant configuration, read once from the environment. Centralizing this
 * keeps env-var names in a single place (DRY) and gives the rest of the
 * merchant a typed config object instead of scattered process.env reads.
 */
import {
  DEFAULT_FACILITATOR_URL,
  USDC_ADDRESS,
  X402_NETWORK,
} from "@agentic-payments/shared";

export type FacilitatorMode = "http" | "mock";

export interface MerchantConfig {
  port: number;
  /** Address that receives USDC (the merchant's wallet). */
  payTo: `0x${string}`;
  network: typeof X402_NETWORK;
  asset: `0x${string}`;
  facilitatorMode: FacilitatorMode;
  facilitatorUrl: string;
  /** Settlement retry policy (see ResilientFacilitatorClient). */
  settleMaxAttempts: number;
  settleBaseDelayMs: number;
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

export function loadMerchantConfig(
  env: NodeJS.ProcessEnv = process.env,
): MerchantConfig {
  const mode = (env.FACILITATOR_MODE as FacilitatorMode) ?? "http";
  return {
    port: Number(env.MERCHANT_PORT ?? 4021),
    // In mock mode we don't need a real address; default to a placeholder.
    payTo: (mode === "mock"
      ? (env.MERCHANT_PAY_TO ?? "0x000000000000000000000000000000000000dEaD")
      : required("MERCHANT_PAY_TO", env.MERCHANT_PAY_TO)
    ).toLowerCase() as `0x${string}`,
    network: X402_NETWORK,
    asset: USDC_ADDRESS,
    facilitatorMode: mode,
    facilitatorUrl: env.X402_FACILITATOR_URL ?? DEFAULT_FACILITATOR_URL,
    settleMaxAttempts: Number(env.SETTLE_MAX_ATTEMPTS ?? 4),
    settleBaseDelayMs: Number(env.SETTLE_BASE_DELAY_MS ?? 250),
  };
}
