/**
 * Option B setup — a real Base Sepolia settlement with NO CDP wallet / no
 * business verification. Generates a persistent throwaway agent key + a merchant
 * receiving address, writes them to .env (along with WALLET_MODE=local,
 * FACILITATOR_MODE=http), and prints the address to fund.
 *
 * The private key is written to .env (gitignored) and never printed. The agent
 * signs gasless EIP-3009 authorizations; the x402.org facilitator submits the
 * settlement on-chain — so the agent wallet needs only test USDC, no ETH.
 *
 * Run: `npm run setup:local`, fund the printed address, then run the live demo.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ENV = ".env";
const ZERO = "0x0000000000000000000000000000000000000000";

function readEnv(): string {
  return existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
}

function getVal(text: string, key: string): string | undefined {
  const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, "m"));
  return m && m[1] !== undefined ? m[1].trim() : undefined;
}

function upsert(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  if (re.test(text)) return text.replace(re, line);
  const sep = text === "" || text.endsWith("\n") ? "" : "\n";
  return `${text}${sep}${line}\n`;
}

let text = readEnv();

// Reuse an existing valid agent key so re-running keeps the same funded address.
let agentKey = getVal(text, "AGENT_PRIVATE_KEY");
if (!agentKey || !/^0x[0-9a-fA-F]{64}$/.test(agentKey)) {
  agentKey = generatePrivateKey();
}
const agentAddress = privateKeyToAccount(agentKey as `0x${string}`).address;

// Merchant receiving address (a fresh address is fine — we only need to receive).
let merchant = getVal(text, "MERCHANT_PAY_TO");
if (!merchant || !/^0x[0-9a-fA-F]{40}$/.test(merchant) || merchant.toLowerCase() === ZERO) {
  merchant = privateKeyToAccount(generatePrivateKey()).address;
}

text = upsert(text, "WALLET_MODE", "local");
text = upsert(text, "FACILITATOR_MODE", "http");
text = upsert(text, "AGENT_PRIVATE_KEY", agentKey);
text = upsert(text, "MERCHANT_PAY_TO", merchant);
writeFileSync(ENV, text);

console.log(`
.env updated (WALLET_MODE=local, FACILITATOR_MODE=http).
  agent wallet (payer, FUND THIS): ${agentAddress}
  merchant wallet (payTo):         ${merchant}

─────────────────────────────────────────────────────────────
Next steps:

1) Fund the AGENT address with test USDC on Base Sepolia:
     https://faucet.circle.com   (select "Base Sepolia", paste ${agentAddress})
   No ETH needed — settlement is gasless (the facilitator submits the tx).

2) Start the merchant (real facilitator) in one terminal:
     npm run merchant

3) Run the agent (real settlement) in another terminal:
     npm run agent allergy-relief-24

Watch the receipt + order for a real settlement tx hash, and view the wallets on
   https://sepolia.basescan.org/address/${agentAddress}
─────────────────────────────────────────────────────────────`);
