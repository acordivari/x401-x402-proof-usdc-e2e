/**
 * Network registry — the single source of truth for every chain this project
 * can pay on. `constants.ts` derives the sandbox defaults (Base Sepolia) from
 * here, and the live buyer selects a network at runtime, so adding a chain is
 * one entry here rather than edits scattered across agent/merchant/validators.
 *
 * Mainnet is intentionally present but never the default: everything that can
 * spend real funds must opt in explicitly (see packages/agent/src/live/).
 */

export interface NetworkConfig {
  /** CAIP-2 identifier the x402 v2 stack + facilitators expect. */
  readonly caip2: `eip155:${number}`;
  /** Numeric EVM chain id. */
  readonly chainId: number;
  /** Human-readable name for logs and CLI output. */
  readonly name: string;
  /** Native USDC contract on this chain, normalized lowercase. */
  readonly usdcAddress: `0x${string}`;
  readonly usdcDecimals: 6;
  /** Public RPC endpoint (override per-run via BASE_RPC_URL). */
  readonly rpcUrl: string;
  /** Block-explorer base for transaction links. */
  readonly explorerTxBase: string;
  readonly testnet: boolean;
}

export const BASE_SEPOLIA = {
  caip2: "eip155:84532",
  chainId: 84532,
  name: "Base Sepolia (testnet)",
  usdcAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  usdcDecimals: 6,
  rpcUrl: "https://sepolia.base.org",
  explorerTxBase: "https://sepolia.basescan.org/tx/",
  testnet: true,
} as const satisfies NetworkConfig;

export const BASE_MAINNET = {
  caip2: "eip155:8453",
  chainId: 8453,
  name: "Base (mainnet — REAL FUNDS)",
  usdcAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  usdcDecimals: 6,
  rpcUrl: "https://mainnet.base.org",
  explorerTxBase: "https://basescan.org/tx/",
  testnet: false,
} as const satisfies NetworkConfig;

export const NETWORKS: Readonly<Record<string, NetworkConfig>> = {
  [BASE_SEPOLIA.caip2]: BASE_SEPOLIA,
  [BASE_MAINNET.caip2]: BASE_MAINNET,
};

/** Resolve a CAIP-2 id to its config; unknown networks are a hard error. */
export function getNetwork(caip2: string): NetworkConfig {
  const net = NETWORKS[caip2];
  if (!net) {
    throw new Error(
      `unknown network "${caip2}" — known: ${Object.keys(NETWORKS).join(", ")}`,
    );
  }
  return net;
}

export function explorerTxUrl(net: NetworkConfig, txHash: string): string {
  return `${net.explorerTxBase}${txHash}`;
}
