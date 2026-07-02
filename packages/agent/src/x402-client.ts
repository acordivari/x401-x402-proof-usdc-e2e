/**
 * Wraps `fetch` with x402 payment handling. On a 402 the client uses the
 * agent's signer to produce an EIP-3009 authorization and retries the request
 * automatically — so the buyer flow just calls `fetchWithPayment(url)`.
 */
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import type { PaymentPolicy } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { X402_NETWORK, type PaymentSigner } from "@agentic-payments/shared";

export interface X402ClientOptions {
  /** Optional RPC URL for the exact EVM scheme. */
  rpcUrl?: string;
  /** CAIP-2 network to register (defaults to the sandbox's Base Sepolia). */
  network?: `${string}:${string}`;
  /**
   * Payment policies applied INSIDE the client before anything is signed —
   * they filter the acceptable PaymentRequirements, so a cap or allowlist
   * enforced here cannot be bypassed by a merchant changing terms between a
   * preflight check and the paying retry.
   */
  policies?: PaymentPolicy[];
}

export async function createPayingFetch(
  signer: PaymentSigner,
  opts: X402ClientOptions = {},
): Promise<typeof fetch> {
  const account = await signer.getAccount();
  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: account as never,
    networks: [opts.network ?? X402_NETWORK],
    ...(opts.policies ? { policies: opts.policies } : {}),
    ...(opts.rpcUrl ? { schemeOptions: { rpcUrl: opts.rpcUrl } } : {}),
  });
  return wrapFetchWithPayment(fetch, client) as typeof fetch;
}
