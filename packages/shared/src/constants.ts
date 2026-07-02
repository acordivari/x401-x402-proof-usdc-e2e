/**
 * Sandbox defaults, derived from the network registry (`networks.ts`).
 * Everything in the sandbox is Base Sepolia testnet — no mainnet, no real
 * funds. The live buyer (packages/agent/src/live/) opts into other networks
 * explicitly via the registry.
 */
import { BASE_SEPOLIA } from "./networks.ts";

/** CAIP-2 network identifier the x402 SDK + facilitator expect. */
export const X402_NETWORK = BASE_SEPOLIA.caip2;

/** Numeric EVM chain id for Base Sepolia. */
export const CHAIN_ID = BASE_SEPOLIA.chainId;

/**
 * Circle's official test USDC on Base Sepolia (6 decimals).
 * Faucet: https://faucet.circle.com  (select Base Sepolia).
 * Stored lowercase so address comparisons are normalized everywhere.
 */
export const USDC_ADDRESS = BASE_SEPOLIA.usdcAddress;

export const USDC_DECIMALS = 6 as const;
export const USDC_SYMBOL = "USDC" as const;

/**
 * Free testnet facilitator — no API key required. Note the `www.`: as of
 * 2026-07 the bare `x402.org` host 302s to a Linux Foundation site (the
 * foundation handoff) and no longer proxies the facilitator API.
 */
export const DEFAULT_FACILITATOR_URL =
  "https://www.x402.org/facilitator" as const;

/** The only x402 payment scheme we support in this sandbox. */
export const PAYMENT_SCHEME = "exact" as const;

/** x402 protocol version we target. */
export const X402_VERSION = 2 as const;

/**
 * Assets we will ever accept, normalized lowercase. The payment-parameter
 * validator rejects anything not on this allowlist before settlement.
 */
export const ASSET_ALLOWLIST: readonly string[] = [USDC_ADDRESS];
