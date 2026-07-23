/**
 * Account-control verification — proves the agent actually *controls* the
 * wallet an Intent mandate is about to bind, per the wallet-native
 * identity profile: externally-owned accounts sign the wallet-control message
 * with EIP-191 (verified by pure secp256k1 recovery, offline), smart-contract
 * accounts answer ERC-1271 `isValidSignature` on-chain.
 *
 * The swappable seam: `AuthorizationService` takes any `AccountControlVerifier`.
 * When one is configured, issuance REQUIRES a valid proof — fail-closed; when
 * none is configured, issuance trusts the caller's binding (in-process wallets,
 * pre-existing tests). The message being signed is
 * `buildWalletControlMessage` from @agentic-payments/shared.
 */
import { createPublicClient, http, recoverMessageAddress } from "viem";
import { collect, type ValidationResult } from "@agentic-payments/shared";

/** The agent's proof that it controls the wallet being bound. */
export interface WalletControlProof {
  /** The single-use challenge the signature is bound to (the x401 challenge). */
  challenge: string;
  /** Personal-sign (EIP-191) signature over the wallet-control message. */
  signature: `0x${string}`;
}

export interface AccountControlInput {
  address: `0x${string}`;
  message: string;
  signature: `0x${string}`;
}

export interface AccountControlVerifier {
  verifyControl(input: AccountControlInput): Promise<ValidationResult>;
}

/** EIP-191 personal-sign recovery — EOAs only. Pure crypto, runs offline. */
export function eip191AccountControl(): AccountControlVerifier {
  return {
    async verifyControl({ address, message, signature }) {
      try {
        const recovered = await recoverMessageAddress({ message, signature });
        return collect([
          recovered.toLowerCase() === address.toLowerCase()
            ? null
            : `wallet-control signature recovers ${recovered.toLowerCase()}, not ${address}`,
        ]);
      } catch (err) {
        return collect([`wallet-control signature is unverifiable: ${(err as Error).message}`]);
      }
    },
  };
}

/**
 * On-chain verification via viem's `publicClient.verifyMessage` — covers EOAs,
 * ERC-1271 smart accounts, and ERC-6492 pre-deploy accounts. Needs an RPC, so
 * this is the live impl; an RPC failure is a violation (fail-closed), never a
 * pass.
 */
export function erc1271AccountControl(opts: {
  rpcUrl: string;
  /** Injectable for offline tests (mirrors the live buyer's readBalance). */
  verifyFn?: (input: AccountControlInput) => Promise<boolean>;
}): AccountControlVerifier {
  const verify =
    opts.verifyFn ??
    ((input: AccountControlInput) =>
      createPublicClient({ transport: http(opts.rpcUrl) }).verifyMessage(input));
  return {
    async verifyControl(input) {
      try {
        return collect([
          (await verify(input))
            ? null
            : `wallet-control signature is not valid for ${input.address}`,
        ]);
      } catch (err) {
        return collect([`wallet-control verification unavailable: ${(err as Error).message}`]);
      }
    },
  };
}
