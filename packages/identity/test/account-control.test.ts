/**
 * The account-control seam: EIP-191 recovery for EOAs, the
 * ERC-1271 impl behind an injectable verify (offline), and the
 * AuthorizationService's fail-closed issuance rules when the seam is
 * configured — no proof, a wrong-wallet proof, and a proof bound to a
 * different challenge must all refuse to issue.
 */
import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildAgentDid, buildWalletControlMessage } from "@agentic-payments/shared";
import type { VerifiedAuthorization } from "@agentic-payments/credentials";
import {
  AuthorizationService,
  MandateSigner,
  createSigningKeyPair,
  eip191AccountControl,
  erc1271AccountControl,
} from "../src/index.ts";

const NETWORK = "eip155:84532" as const;

async function signedControl(challenge: string) {
  const account = privateKeyToAccount(generatePrivateKey());
  const address = account.address.toLowerCase() as `0x${string}`;
  const agentId = buildAgentDid(NETWORK, address);
  const message = buildWalletControlMessage({ agentId, challenge });
  const signature = await account.signMessage({ message });
  return { account, address, agentId, message, signature };
}

describe("eip191AccountControl", () => {
  it("accepts a signature from the bound wallet", async () => {
    const { address, message, signature } = await signedControl("c-1");
    const res = await eip191AccountControl().verifyControl({ address, message, signature });
    expect(res.ok).toBe(true);
  });

  it("rejects a signature from a different wallet", async () => {
    const { message, signature } = await signedControl("c-1");
    const other = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as `0x${string}`;
    const res = await eip191AccountControl().verifyControl({ address: other, message, signature });
    expect(res.ok === false && res.violations.join()).toMatch(/recovers/);
  });

  it("rejects a signature over a different message (challenge swap)", async () => {
    const { address, agentId, signature } = await signedControl("c-1");
    const res = await eip191AccountControl().verifyControl({
      address,
      message: buildWalletControlMessage({ agentId, challenge: "c-2" }),
      signature,
    });
    expect(res.ok).toBe(false);
  });

  it("fails closed on garbage signatures", async () => {
    const res = await eip191AccountControl().verifyControl({
      address: "0x1111111111111111111111111111111111111111",
      message: "m",
      signature: "0xnot-a-signature" as `0x${string}`,
    });
    expect(res.ok === false && res.violations.join()).toMatch(/unverifiable/);
  });
});

describe("erc1271AccountControl (injected verify)", () => {
  const input = {
    address: "0x1111111111111111111111111111111111111111" as const,
    message: "m",
    signature: "0xabcd" as `0x${string}`,
  };

  it("passes when the account validates the signature", async () => {
    const res = await erc1271AccountControl({ rpcUrl: "unused", verifyFn: async () => true }).verifyControl(input);
    expect(res.ok).toBe(true);
  });

  it("rejects when the account does not validate it", async () => {
    const res = await erc1271AccountControl({ rpcUrl: "unused", verifyFn: async () => false }).verifyControl(input);
    expect(res.ok === false && res.violations.join()).toMatch(/not valid/);
  });

  it("fails closed when the RPC is unavailable", async () => {
    const res = await erc1271AccountControl({
      rpcUrl: "unused",
      verifyFn: async () => { throw new Error("rpc down"); },
    }).verifyControl(input);
    expect(res.ok === false && res.violations.join()).toMatch(/unavailable/);
  });
});

describe("AuthorizationService with account control configured", () => {
  const CHALLENGE = "challenge-abc";

  // A minimal verified authorization for issueIntentFromPresentation — the
  // presentation checks are out of scope here (covered by the x401 tests).
  const authorization = {
    result: { ok: true },
    challengeOk: true,
    txDataBound: true,
    challenge: CHALLENGE,
  } as VerifiedAuthorization;

  async function makeService() {
    const asKey = await createSigningKeyPair("account-control-test");
    return new AuthorizationService(
      { verify: async () => { throw new Error("OIDC unused"); } } as never,
      new MandateSigner(asKey),
      undefined,
      undefined,
      eip191AccountControl(),
    );
  }

  function issueReq(address: `0x${string}`) {
    return {
      authorization,
      agentWallet: address,
      scope: {
        maxAmount: "1000000",
        merchantAllowlist: ["0x1111111111111111111111111111111111111111" as const],
        allowedCategories: ["open-web"],
      },
      network: NETWORK,
    };
  }

  it("issues when the proof is valid and challenge-bound", async () => {
    const service = await makeService();
    const { address, signature } = await signedControl(CHALLENGE);
    const intent = await service.issueIntentFromPresentation({
      ...issueReq(address),
      walletProof: { challenge: CHALLENGE, signature },
    });
    expect(intent.agentId).toBe(buildAgentDid(NETWORK, address));
    expect(intent.proof?.signature).toBeTruthy();
  });

  it("refuses issuance without a wallet-control proof", async () => {
    const service = await makeService();
    const { address } = await signedControl(CHALLENGE);
    await expect(service.issueIntentFromPresentation(issueReq(address))).rejects.toThrow(
      /wallet-control proof required/,
    );
  });

  it("refuses a proof bound to a different challenge than the presentation", async () => {
    const service = await makeService();
    const { address, agentId } = await signedControl(CHALLENGE);
    // Signed correctly — but over another challenge (a replayed proof).
    const other = await signedControl("other-challenge");
    const replayed = await other.account.signMessage({
      message: buildWalletControlMessage({ agentId, challenge: "other-challenge" }),
    });
    await expect(
      service.issueIntentFromPresentation({
        ...issueReq(address),
        walletProof: { challenge: "other-challenge", signature: replayed },
      }),
    ).rejects.toThrow(/not bound to this authorization's challenge/);
  });

  it("refuses a proof signed by a wallet other than the one being bound", async () => {
    const service = await makeService();
    const { address } = await signedControl(CHALLENGE);
    const impostor = await signedControl(CHALLENGE);
    // The impostor signs the victim's binding message with its own key.
    const forged = await impostor.account.signMessage({
      message: buildWalletControlMessage({
        agentId: buildAgentDid(NETWORK, address),
        challenge: CHALLENGE,
      }),
    });
    await expect(
      service.issueIntentFromPresentation({
        ...issueReq(address),
        walletProof: { challenge: CHALLENGE, signature: forged },
      }),
    ).rejects.toThrow(/recovers/);
  });
});
