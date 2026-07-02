/**
 * Discover live x402-payable resources via the Bazaar index (Coinbase-run,
 * read access needs no API key) or the free testnet facilitator's catalog.
 *
 *   npm run live:discover                      # testnet catalog
 *   npm run live:discover -- --mainnet --max 0.02 --query search
 *
 * Output is a shortlist you can hand straight to `npm run live:buy -- <url>`.
 */
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  BASE_MAINNET,
  BASE_SEPOLIA,
  atomicToDollars,
  dollarsToAtomic,
  type NetworkConfig,
} from "@agentic-payments/shared";

/**
 * The Bazaar indexes both mainnet and testnet resources (read access needs no
 * key); we filter by the wanted network. Testnet listings are sparse — for a
 * full testnet loop, run this repo's own merchant against the free facilitator
 * instead (README "Live Base Sepolia path").
 */
const BAZAAR_URL =
  "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";

interface DiscoveredResource {
  url: string;
  method?: string;
  description?: string;
  priceAtomic: bigint;
  network: string;
  payTo?: string;
}

/**
 * The index's item shape isn't versioned for us, so parse defensively: keep
 * anything with a resource URL and at least one accepts entry on the wanted
 * network, and skip the rest rather than failing the whole listing.
 */
function parseListing(payload: unknown, net: NetworkConfig): DiscoveredResource[] {
  const root = payload as Record<string, unknown>;
  const items = (root.items ?? root.data ?? root.resources ?? payload) as unknown[];
  if (!Array.isArray(items)) return [];

  const out: DiscoveredResource[] = [];
  for (const raw of items) {
    const item = raw as Record<string, unknown>;
    const url = typeof item.resource === "string" ? item.resource : undefined;
    const accepts = Array.isArray(item.accepts) ? (item.accepts as Record<string, unknown>[]) : [];
    if (!url) continue;
    for (const a of accepts) {
      if (a.network !== net.caip2) continue;
      const amount = a.amount ?? a.maxAmountRequired;
      if (typeof amount !== "string" || !/^\d+$/.test(amount)) continue;
      const meta = (item.metadata ?? {}) as Record<string, unknown>;
      out.push({
        url,
        method: typeof item.type === "string" ? item.type : undefined,
        description:
          typeof meta.description === "string"
            ? meta.description
            : typeof a.description === "string"
              ? (a.description as string)
              : undefined,
        priceAtomic: BigInt(amount),
        network: a.network,
        payTo: typeof a.payTo === "string" ? a.payTo : undefined,
      });
      break; // one row per resource
    }
  }
  return out;
}

export async function discover(opts: {
  network: NetworkConfig;
  maxUsdc: string;
  query?: string;
  limit: number;
}): Promise<DiscoveredResource[]> {
  const res = await fetch(BAZAAR_URL);
  if (!res.ok) {
    throw new Error(`discovery index ${BAZAAR_URL} returned HTTP ${res.status}`);
  }
  const listing = parseListing(await res.json(), opts.network);
  const maxAtomic = dollarsToAtomic(opts.maxUsdc);
  const q = opts.query?.toLowerCase();
  return listing
    .filter((r) => r.priceAtomic <= maxAtomic)
    .filter(
      (r) =>
        !q ||
        r.url.toLowerCase().includes(q) ||
        (r.description ?? "").toLowerCase().includes(q),
    )
    .sort((a, b) => (a.priceAtomic < b.priceAtomic ? -1 : 1))
    .slice(0, opts.limit);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const { values } = parseArgs({
    options: {
      mainnet: { type: "boolean", default: false },
      max: { type: "string", default: "0.05" },
      query: { type: "string" },
      limit: { type: "string", default: "20" },
    },
  });
  const network = values.mainnet ? BASE_MAINNET : BASE_SEPOLIA;
  discover({
    network,
    maxUsdc: values.max,
    query: values.query,
    limit: Number(values.limit),
  })
    .then((rows) => {
      console.log(
        `[discover] ${rows.length} resource(s) on ${network.name} priced <= ${values.max} USDC` +
          (values.query ? ` matching "${values.query}"` : ""),
      );
      for (const r of rows) {
        const price = atomicToDollars(r.priceAtomic).padStart(8);
        const desc = r.description ? `  — ${r.description.slice(0, 60)}` : "";
        console.log(`  ${price} USDC  ${r.method ?? ""} ${r.url}${desc}`);
      }
      if (rows.length === 0) {
        console.log("  (try a higher --max, a different --query, or --mainnet)");
      }
    })
    .catch((err) => {
      console.error(`[discover] failed: ${(err as Error).message}`);
      process.exit(1);
    });
}
