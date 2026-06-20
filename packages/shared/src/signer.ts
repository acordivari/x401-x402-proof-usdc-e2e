/**
 * Wallet abstraction. The x402 client signs EIP-3009 authorizations with a
 * viem-compatible account; everything else in the codebase only needs the
 * address. Keeping this interface tiny means the CDP Server Wallet (Phase 1),
 * a throwaway viem key (tests/fallback), or Turnkey later are all swappable
 * without touching the agent's payment logic.
 */
import type { Account } from "viem";

export interface PaymentSigner {
  /** Lowercase 0x address that will appear as the payer / agent wallet. */
  readonly address: `0x${string}`;
  /** A viem account the x402 `exact` scheme uses to sign authorizations. */
  getAccount(): Promise<Account> | Account;
  /** Human-readable label for logs (e.g. "cdp:buyer-agent", "local:test"). */
  readonly label: string;
}
