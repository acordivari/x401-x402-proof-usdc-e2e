import { describe, expect, it, vi } from "vitest";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { X402_NETWORK } from "@agentic-payments/shared";
import { MockFacilitator } from "../src/facilitator/mock.ts";
import { ResilientFacilitatorClient } from "../src/facilitator/resilient.ts";
import { TransientFacilitatorError } from "../src/facilitator/errors.ts";

const noSleep = () => Promise.resolve();

function reqs(): PaymentRequirements {
  return {
    scheme: "exact",
    network: X402_NETWORK,
    asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    amount: "1500000",
    payTo: "0x1111111111111111111111111111111111111111",
    maxTimeoutSeconds: 120,
    extra: {},
  } as PaymentRequirements;
}

function pay(nonce: string): PaymentPayload {
  return {
    x402Version: 2,
    payload: {
      signature: "0x" + "cd".repeat(65),
      authorization: {
        from: "0x2222222222222222222222222222222222222222",
        to: "0x1111111111111111111111111111111111111111",
        value: "1500000",
        validAfter: "0",
        validBefore: "99999999999",
        nonce,
      },
    },
  } as unknown as PaymentPayload;
}

/** Counting inner client whose settle behavior is configurable per call. */
class CountingFacilitator implements FacilitatorClient {
  calls = 0;
  constructor(private readonly behavior: (call: number) => SettleResponse) {}
  async verify(): Promise<VerifyResponse> {
    return { isValid: true };
  }
  async settle(): Promise<SettleResponse> {
    this.calls++;
    return this.behavior(this.calls);
  }
  async getSupported(): Promise<SupportedResponse> {
    return { kinds: [], extensions: [], signers: {} };
  }
}

const success = (call: number): SettleResponse => ({
  success: true,
  transaction: `0xtx${call}`,
  network: X402_NETWORK,
});

describe("ResilientFacilitatorClient — retry", () => {
  it("settles on the first try when the facilitator is healthy", async () => {
    const inner = new MockFacilitator();
    const rfc = new ResilientFacilitatorClient(inner, { sleep: noSleep });
    const res = await rfc.settle(pay("0xa1"), reqs());
    expect(res.success).toBe(true);
    expect(inner.settleAttempts).toBe(1);
  });

  it("retries transient failures with backoff, then succeeds", async () => {
    const inner = new MockFacilitator({ failSettleTimes: 2 });
    const sleep = vi.fn(noSleep);
    const rfc = new ResilientFacilitatorClient(inner, { maxAttempts: 4, baseDelayMs: 100, sleep });
    const res = await rfc.settle(pay("0xa2"), reqs());
    expect(res.success).toBe(true);
    expect(inner.settleAttempts).toBe(3); // 2 failures + 1 success
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 100); // 100 * 2^0
    expect(sleep).toHaveBeenNthCalledWith(2, 200); // 100 * 2^1
  });

  it("gives up after maxAttempts on persistent transient failure", async () => {
    const inner = new MockFacilitator({ failSettleTimes: 99 });
    const rfc = new ResilientFacilitatorClient(inner, { maxAttempts: 3, sleep: noSleep });
    await expect(rfc.settle(pay("0xa3"), reqs())).rejects.toBeInstanceOf(
      TransientFacilitatorError,
    );
    expect(inner.settleAttempts).toBe(3);
  });

  it("does NOT retry a terminal (success:false) settlement", async () => {
    const inner = new CountingFacilitator(() => ({
      success: false,
      errorReason: "insufficient_funds",
      transaction: "",
      network: X402_NETWORK,
    }));
    const rfc = new ResilientFacilitatorClient(inner, { maxAttempts: 5, sleep: noSleep });
    const res = await rfc.settle(pay("0xa4"), reqs());
    expect(res.success).toBe(false);
    expect(inner.calls).toBe(1); // not retried
  });
});

describe("ResilientFacilitatorClient — idempotency + transaction lock", () => {
  it("never settles the same nonce twice (sequential replay)", async () => {
    const inner = new CountingFacilitator(success);
    const rfc = new ResilientFacilitatorClient(inner, { sleep: noSleep });
    const first = await rfc.settle(pay("0xdup"), reqs());
    const second = await rfc.settle(pay("0xdup"), reqs());
    expect(inner.calls).toBe(1);
    expect(second).toEqual(first); // cached result returned verbatim
  });

  it("coalesces concurrent settlements of the same nonce (transaction lock)", async () => {
    const inner = new CountingFacilitator(success);
    const rfc = new ResilientFacilitatorClient(inner, { sleep: noSleep });
    const [a, b, c] = await Promise.all([
      rfc.settle(pay("0xrace"), reqs()),
      rfc.settle(pay("0xrace"), reqs()),
      rfc.settle(pay("0xrace"), reqs()),
    ]);
    expect(inner.calls).toBe(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("settles distinct nonces independently", async () => {
    const inner = new CountingFacilitator(success);
    const rfc = new ResilientFacilitatorClient(inner, { sleep: noSleep });
    await rfc.settle(pay("0xn1"), reqs());
    await rfc.settle(pay("0xn2"), reqs());
    expect(inner.calls).toBe(2);
  });

  it("is case-insensitive on the nonce key", async () => {
    const inner = new CountingFacilitator(success);
    const rfc = new ResilientFacilitatorClient(inner, { sleep: noSleep });
    await rfc.settle(pay("0xABCDEF"), reqs());
    await rfc.settle(pay("0xabcdef"), reqs());
    expect(inner.calls).toBe(1);
  });
});
