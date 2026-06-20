/**
 * Offline mock facilitator. Implements the same FacilitatorClient interface the
 * real Coinbase/x402.org facilitator does, but settles nothing on-chain — it
 * returns a deterministic synthetic transaction hash. This lets the full agent
 * -> merchant -> facilitator round-trip run in tests and demos with no API key
 * and no funds.
 *
 * It can be told to fail settlement transiently N times to exercise the
 * resilient client's retry path.
 */
import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  PAYMENT_SCHEME,
  USDC_ADDRESS,
  X402_NETWORK,
} from "@agentic-payments/shared";
import { TransientFacilitatorError } from "./errors.ts";

export interface MockFacilitatorOptions {
  /** Number of transient settlement failures before the first success. */
  failSettleTimes?: number;
  /** Override the synthetic tx hash derivation (defaults to nonce-based). */
  txHashFor?: (nonce: string) => string;
}

export class MockFacilitator implements FacilitatorClient {
  private remainingFailures: number;
  private readonly txHashFor: (nonce: string) => string;
  /** Settlement attempts observed, exposed so tests can assert retry counts. */
  settleAttempts = 0;

  constructor(opts: MockFacilitatorOptions = {}) {
    this.remainingFailures = opts.failSettleTimes ?? 0;
    this.txHashFor =
      opts.txHashFor ??
      ((nonce) => `0xmocktx${nonce.replace(/^0x/, "").slice(0, 56)}`);
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const auth = (payload as any).payload?.authorization;
    const okRecipient = auth?.to?.toLowerCase() === requirements.payTo.toLowerCase();
    const okAmount = auth?.value === requirements.amount;
    if (!okRecipient || !okAmount) {
      return { isValid: false, invalidReason: "mock: payment does not match requirements" };
    }
    return { isValid: true, payer: auth?.from };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    this.settleAttempts++;
    if (this.remainingFailures > 0) {
      this.remainingFailures--;
      throw new TransientFacilitatorError("mock: facilitator temporarily unavailable");
    }
    const auth = (payload as any).payload?.authorization;
    return {
      success: true,
      transaction: this.txHashFor(auth?.nonce ?? "0x"),
      network: requirements.network,
      payer: auth?.from,
    };
  }

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [{ x402Version: 2, scheme: PAYMENT_SCHEME, network: X402_NETWORK }],
      extensions: [],
      signers: { [X402_NETWORK]: [USDC_ADDRESS] },
    };
  }
}
