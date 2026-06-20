/**
 * Single source of truth for network + asset configuration.
 * Everything is Base Sepolia testnet — no mainnet, no real funds.
 */

/** CAIP-2 network identifier the x402 SDK + facilitator expect. */
export const X402_NETWORK = "eip155:84532" as const;

/** Numeric EVM chain id for Base Sepolia. */
export const CHAIN_ID = 84532 as const;

/**
 * Circle's official test USDC on Base Sepolia (6 decimals).
 * Faucet: https://faucet.circle.com  (select Base Sepolia).
 * Stored lowercase so address comparisons are normalized everywhere.
 */
export const USDC_ADDRESS =
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as const;

export const USDC_DECIMALS = 6 as const;
export const USDC_SYMBOL = "USDC" as const;

/** Free testnet facilitator — no API key required. */
export const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator" as const;

/** The only x402 payment scheme we support in this sandbox. */
export const PAYMENT_SCHEME = "exact" as const;

/** x402 protocol version we target. */
export const X402_VERSION = 2 as const;

/**
 * Assets we will ever accept, normalized lowercase. The payment-parameter
 * validator rejects anything not on this allowlist before settlement.
 */
export const ASSET_ALLOWLIST: readonly string[] = [USDC_ADDRESS];
