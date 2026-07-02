/**
 * Live buyer CLI — pay a real external x402 resource with hard guardrails.
 *
 *   npm run live:buy -- <url> [--mainnet] [--max 0.05] [--budget 1.00]
 *                            [--method POST] [--body '{"query":"..."}'] [--yes]
 *
 * Safety model (all fail-closed):
 *   - dry-run by default: shows the decoded quote and stops; `--yes` pays.
 *   - testnet by default: `--mainnet` is the only way to touch real funds.
 *   - per-call cap (`--max`) and a durable cumulative budget (`--budget`,
 *     tracked in a spend journal file) are enforced BEFORE paying, and the
 *     same rules run again inside the x402 client as a PaymentPolicy pinned
 *     to the preflighted payee — so terms can't shift between look and pay.
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { createPublicClient, erc20Abi, http } from "viem";
import {
  BASE_MAINNET,
  BASE_SEPOLIA,
  atomicToDollars,
  dollarsToAtomic,
  explorerTxUrl,
  loadEnv,
  type NetworkConfig,
} from "@agentic-payments/shared";
import { decodePaymentResponseHeader } from "@x402/fetch";
import { createLocalSigner, createSigner } from "../wallet.ts";
import { createPayingFetch } from "../x402-client.ts";
import { evaluateQuote, createSpendGuardPolicy, type SpendGuardConfig } from "./guard.ts";
import { LiveSpendJournal } from "./journal.ts";
import { loadMandateGrant, verifyMandateGrant, type LiveMandateFile } from "./mandate.ts";
import { preflight } from "./quotes.ts";

export interface LiveBuyOptions {
  url: string;
  network: NetworkConfig;
  maxPerCallUsdc: string;
  budgetUsdc: string;
  method: string;
  body?: string;
  journalPath: string;
  execute: boolean; // false = dry run
  rpcUrl?: string;
  /**
   * Path to a standing-mandate grant file (from live:grant). When set, the
   * buyer refuses to spend unless the signed mandate verifies, binds this
   * wallet, allowlists the payee, and has cumulative-cap headroom.
   */
  mandatePath?: string;
  /**
   * USDC balance reader — defaults to an on-chain read via the network's RPC.
   * Injectable (like every risky boundary here) so the flow runs offline in
   * tests against the mock-facilitator merchant.
   */
  readBalance?: (address: `0x${string}`) => Promise<bigint>;
}

export async function runLiveBuy(opts: LiveBuyOptions): Promise<number> {
  const net = opts.network;
  const guard: SpendGuardConfig = {
    network: net,
    maxPerCallAtomic: dollarsToAtomic(opts.maxPerCallUsdc),
  };
  const budgetAtomic = dollarsToAtomic(opts.budgetUsdc);

  console.log(`[live-buy] target   ${opts.method} ${opts.url}`);
  console.log(`[live-buy] network  ${net.name} (${net.caip2})`);

  // 0. Standing mandate (when configured): the signed human authorization that
  //    bounds this run. Its payee allowlist feeds quote evaluation; its
  //    cumulative cap is enforced against the journal below.
  let mandate: LiveMandateFile["intent"] | undefined;
  if (opts.mandatePath) {
    const grant = loadMandateGrant(opts.mandatePath);
    const check = await verifyMandateGrant({ grant, network: net.caip2 });
    if (!check.ok) {
      console.error(`[live-buy] standing mandate rejected: ${check.violations.join("; ")}`);
      return 1;
    }
    mandate = grant.intent;
    guard.payToAllowlist = mandate.scope.merchantAllowlist;
    console.log(
      `[live-buy] mandate  ${mandate.id.slice(0, 8)}… — ${mandate.principal.sub} authorized ` +
        `${atomicToDollars(BigInt(mandate.scope.maxAmount))} USDC across ${mandate.scope.merchantAllowlist.length} payee(s), ` +
        `expires ${new Date(mandate.expiresAt * 1000).toISOString()}`,
    );
  }

  // 1. Preflight: fetch the challenge without paying.
  const init: RequestInit = {
    method: opts.method,
    ...(opts.body
      ? { body: opts.body, headers: { "content-type": "application/json" } }
      : {}),
  };
  const pre = await preflight(opts.url, init);
  if (pre.status !== 402) {
    console.log(`[live-buy] no payment required — HTTP ${pre.status}`);
    if (pre.raw) console.log(String(pre.raw).slice(0, 400));
    return pre.status >= 200 && pre.status < 300 ? 0 : 1;
  }

  // 2. Evaluate every offered option; pick the cheapest acceptable one.
  const verdicts = pre.quotes.map((q) => ({ q, verdict: evaluateQuote(q, guard) }));
  for (const { q, verdict } of verdicts) {
    const price = `${atomicToDollars(BigInt(q.amount))} USDC`;
    const status = verdict.ok ? "OK " : `REJECTED (${verdict.violations.join("; ")})`;
    console.log(`[live-buy] quote    ${price} on ${q.network} -> ${q.payTo}  ${status}`);
  }
  const acceptable = verdicts
    .filter((v) => v.verdict.ok)
    .sort((a, b) => (BigInt(a.q.amount) < BigInt(b.q.amount) ? -1 : 1));
  const chosen = acceptable[0]?.q;
  if (!chosen) {
    console.error("[live-buy] no offered payment option passes the guard — refusing");
    return 1;
  }
  const priceAtomic = BigInt(chosen.amount);

  // 3. Budget headroom (durable across runs via the journal file).
  const journal = new LiveSpendJournal(opts.journalPath);
  const remaining = journal.remainingAtomic(budgetAtomic, net.caip2);
  console.log(
    `[live-buy] budget   spent ${atomicToDollars(journal.spentAtomic(net.caip2))} / ${opts.budgetUsdc} USDC on ${net.caip2} (journal: ${opts.journalPath})`,
  );
  if (priceAtomic > remaining) {
    console.error(
      `[live-buy] price ${atomicToDollars(priceAtomic)} USDC exceeds remaining budget ${atomicToDollars(remaining)} USDC — refusing`,
    );
    return 1;
  }
  if (mandate) {
    const mandateRemaining =
      BigInt(mandate.scope.maxAmount) - journal.spentForMandate(mandate.id);
    console.log(
      `[live-buy] mandate  spent ${atomicToDollars(journal.spentForMandate(mandate.id))} / ${atomicToDollars(BigInt(mandate.scope.maxAmount))} USDC of the standing grant`,
    );
    if (priceAtomic > mandateRemaining) {
      console.error(
        `[live-buy] price ${atomicToDollars(priceAtomic)} USDC exceeds the mandate's remaining cap ${atomicToDollars(mandateRemaining < 0n ? 0n : mandateRemaining)} USDC — refusing`,
      );
      return 1;
    }
  }

  // 4. Wallet + on-chain balance check. In a dry run these are advisory —
  //    quote inspection shouldn't require a funded wallet.
  const env = process.env;
  if (!env.WALLET_MODE) env.WALLET_MODE = env.AGENT_PRIVATE_KEY ? "local" : "cdp";
  let signer;
  let balance: bigint | undefined;
  try {
    if (env.WALLET_MODE === "local" && !env.AGENT_PRIVATE_KEY) {
      throw new Error(
        "WALLET_MODE=local needs AGENT_PRIVATE_KEY (a fresh throwaway key would hold no funds). Run `npm run setup:local` first.",
      );
    }
    signer =
      env.WALLET_MODE === "local"
        ? createLocalSigner(env.AGENT_PRIVATE_KEY as `0x${string}`)
        : await createSigner(env);
    const rpcUrl = opts.rpcUrl ?? net.rpcUrl;
    const readBalance =
      opts.readBalance ??
      ((address: `0x${string}`) =>
        createPublicClient({ transport: http(rpcUrl) }).readContract({
          address: net.usdcAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        }));
    if (mandate && signer.address !== mandate.agentWallet) {
      throw new Error(
        `the standing mandate binds agent ${mandate.agentWallet}, but this wallet is ${signer.address}`,
      );
    }
    balance = await readBalance(signer.address);
    console.log(
      `[live-buy] wallet   ${signer.label} ${signer.address} — ${atomicToDollars(balance)} USDC`,
    );
  } catch (err) {
    if (opts.execute) {
      console.error(`[live-buy] wallet check failed: ${(err as Error).message}`);
      return 1;
    }
    console.warn(`[live-buy] wallet not checked (${(err as Error).message})`);
  }
  if (balance !== undefined && balance < priceAtomic) {
    const hint = net.testnet
      ? "fund it free at https://faucet.circle.com (Base Sepolia)"
      : "fund it with USDC on Base mainnet";
    console.error(`[live-buy] insufficient USDC balance — ${hint}`);
    if (opts.execute) return 1;
  }

  // 5. Dry run stops here.
  if (!opts.execute) {
    console.log(
      `[live-buy] DRY RUN — would pay ${atomicToDollars(priceAtomic)} USDC to ${chosen.payTo}. Re-run with --yes to pay.`,
    );
    return 0;
  }
  if (!signer || balance === undefined) {
    console.error("[live-buy] no usable wallet — cannot pay");
    return 1;
  }

  // 6. Pay. The in-path policy re-checks everything and pins the payee, so
  //    the client refuses to sign if the server's terms shifted since
  //    preflight. Reserve in the journal BEFORE signing.
  const entry = journal.reserve({
    url: opts.url,
    network: net.caip2,
    amountAtomic: chosen.amount,
    payTo: chosen.payTo,
    ...(mandate ? { mandateId: mandate.id } : {}),
  });
  const payingFetch = await createPayingFetch(signer, {
    network: net.caip2,
    rpcUrl: opts.rpcUrl,
    policies: [createSpendGuardPolicy({ ...guard, payToAllowlist: [chosen.payTo] })],
  });

  let res: Response;
  try {
    res = await payingFetch(opts.url, init);
  } catch (err) {
    // Ambiguous: the authorization may or may not have been signed/submitted.
    // Leave the reservation standing (over-count, never over-spend).
    console.error(`[live-buy] payment attempt errored: ${(err as Error).message}`);
    console.error(
      `[live-buy] reservation ${entry.id} left in the journal — verify on-chain before retrying`,
    );
    return 1;
  }

  const receiptHeader =
    res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
  let txHash: string | undefined;
  if (receiptHeader) {
    try {
      const receipt = decodePaymentResponseHeader(receiptHeader);
      txHash = (receipt as { transaction?: string }).transaction;
    } catch {
      console.warn("[live-buy] could not decode the settlement receipt header");
    }
  }

  if (res.ok) {
    journal.commit(entry.id, txHash);
    console.log(`[live-buy] PAID — HTTP ${res.status}`);
    if (txHash) console.log(`[live-buy] settlement ${explorerTxUrl(net, txHash)}`);
    const text = await res.text().catch(() => "");
    console.log(text.slice(0, 800));
    return 0;
  }

  // Non-2xx after a payment attempt: the receipt header tells us if it settled.
  if (txHash) {
    journal.commit(entry.id, txHash);
    console.error(
      `[live-buy] HTTP ${res.status} but payment SETTLED: ${explorerTxUrl(net, txHash)}`,
    );
  } else {
    journal.fail(entry.id, `HTTP ${res.status} with no settlement receipt`);
    console.error(`[live-buy] HTTP ${res.status} — no settlement receipt, journal entry marked failed`);
  }
  console.error((await res.text().catch(() => "")).slice(0, 400));
  return 1;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  loadEnv();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      mainnet: { type: "boolean", default: false },
      max: { type: "string", default: "0.05" },
      budget: { type: "string", default: "1.00" },
      method: { type: "string", default: "GET" },
      body: { type: "string" },
      journal: { type: "string", default: ".live-spend.json" },
      mandate: { type: "string" },
      yes: { type: "boolean", default: false },
    },
  });
  const url = positionals[0];
  if (!url) {
    console.error(
      "usage: npm run live:buy -- <url> [--mainnet] [--max 0.05] [--budget 1.00] [--method POST] [--body '{...}'] [--mandate .live-mandate.json] [--yes]",
    );
    process.exit(2);
  }
  // An explicit --mandate must exist (fail-closed); otherwise the default
  // grant file is enforced automatically when present.
  const mandatePath =
    values.mandate ?? (existsSync(".live-mandate.json") ? ".live-mandate.json" : undefined);
  runLiveBuy({
    url,
    network: values.mainnet ? BASE_MAINNET : BASE_SEPOLIA,
    maxPerCallUsdc: values.max,
    budgetUsdc: values.budget,
    method: values.method.toUpperCase(),
    body: values.body,
    journalPath: values.journal,
    execute: values.yes,
    rpcUrl: process.env.BASE_RPC_URL,
    ...(mandatePath ? { mandatePath } : {}),
  })
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[live-buy] failed: ${(err as Error).message}`);
      process.exit(1);
    });
}
