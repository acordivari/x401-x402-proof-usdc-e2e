#!/usr/bin/env node
/**
 * x401 spec / SDK drift check (Tier 1, invisible feed/poll route).
 *
 * WHY: `@proof.com/x401-node`'s npm *package* version (e.g. 0.3.0) is NOT its
 * *spec* version (`X401_VERSION`, e.g. "0.2.0"), and the spec itself lives in a
 * separate repo (proof/x401) that the SDK lags. We also VENDOR the challenge /
 * encryptor + the `{vp_token, challenge}` result envelope (see x401-binding.ts),
 * so a spec change to nonce / DC-API request `data` / Result Artifact shape is a
 * class of change the SDK will NOT surface for us — only proof/x401 warns us.
 * The Proof VC SDK family is watched too: proof-vc went 0.2.0 → 0.3.1 (a
 * breaking common/server split) on 2026-07-22 without this script noticing,
 * because it only tracked x401-node — hence the multi-package sweep below.
 *
 * This script polls independent signals and compares them to a committed
 * baseline (`x401-spec.lock.json`):
 *   1. npm latest of every @proof.com package we consume → "are we behind?"
 *   2. proof/x401-node + proof/proof-vc-common releases  → "did an SDK repo ship?"
 *   3. proof/x401 latest release/tag/commit              → "did the SPEC move?"
 *
 * INVISIBLE BY DESIGN: every call is an unauthenticated public HTTPS GET (npm
 * registry JSON + api.github.com). No auth token, so the calls are tied to no
 * account; repo owners are never notified and never see an identity. (GitHub's
 * unauth REST limit is 60/req/hr/IP — a handful of calls here is well under it.)
 * Do NOT add a token: it would attribute the reads to your account. It still
 * wouldn't be visible to proof, but "unauthenticated" is the maximally-anonymous
 * posture this was chosen for.
 *
 * USAGE:
 *   node scripts/check-x401-spec.mjs            # report drift; exit 1 if drift
 *   node scripts/check-x401-spec.mjs --update   # reconcile: write current state
 *                                               # into the lock, exit 0
 *   node scripts/check-x401-spec.mjs --json     # machine-readable report
 *
 * EXIT CODES: 0 = in sync (or only network warnings); 1 = actionable drift.
 * Transient fetch failures WARN but do not fail (a scheduled job shouldn't page
 * on a blip); pass --strict to treat fetch failures as drift.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every @proof.com package we consume. `declaredIn` is the workspace
 * package.json that owns the direct dependency (null = transitive: common is
 * the shared base exact-pinned by server/web, and a bump there is the earliest
 * signal the family moved). `specConst` marks the one package that embeds the
 * x401 spec version.
 */
const PACKAGES = [
  { name: "@proof.com/x401-node", declaredIn: "packages/credentials/package.json", specConst: true },
  { name: "@proof.com/proof-vc-server", declaredIn: "packages/credentials/package.json" },
  { name: "@proof.com/proof-vc-web", declaredIn: "apps/wallet-demo/package.json" },
  { name: "@proof.com/proof-vc-common", declaredIn: null },
];

/** proof/proof-vc-common is a monorepo hosting common + server + web. */
const REPOS = [
  { repo: "proof/x401", spec: true },
  { repo: "proof/x401-node" },
  { repo: "proof/proof-vc-common" },
];

const UA = "agentic-payments-x401-drift-check";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(root, "x401-spec.lock.json");
const args = new Set(process.argv.slice(2));
const UPDATE = args.has("--update");
const JSON_OUT = args.has("--json");
const STRICT = args.has("--strict");

const warnings = [];

/**
 * Unauthenticated GET → parsed JSON, or null. Records a warning on failure,
 * EXCEPT a 404 when `soft404` is set (an expected "resource absent" during the
 * release→tag→commit fallback, not a real problem).
 */
async function getJson(url, label, { soft404 = false } = {}) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!res.ok) {
      if (!(soft404 && res.status === 404)) warnings.push(`${label}: HTTP ${res.status} from ${url}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    warnings.push(`${label}: ${err.message}`);
    return null;
  }
}

/** Latest published npm version (dist-tags.latest). */
async function npmLatest(pkg) {
  const meta = await getJson(`https://registry.npmjs.org/${pkg}`, `npm registry (${pkg})`);
  return meta?.["dist-tags"]?.latest ?? null;
}

/**
 * Latest "reference" for a GitHub repo, degrading gracefully: release → tag →
 * HEAD commit. Returns { kind, ref, date } or null.
 */
async function githubLatest(repo) {
  const rel = await getJson(`https://api.github.com/repos/${repo}/releases/latest`, `${repo} releases`, { soft404: true });
  if (rel?.tag_name) return { kind: "release", ref: rel.tag_name, date: rel.published_at ?? null };

  const tags = await getJson(`https://api.github.com/repos/${repo}/tags?per_page=1`, `${repo} tags`, { soft404: true });
  if (Array.isArray(tags) && tags[0]?.name) return { kind: "tag", ref: tags[0].name, date: null };

  const commits = await getJson(`https://api.github.com/repos/${repo}/commits?per_page=1`, `${repo} commits`);
  if (Array.isArray(commits) && commits[0]?.sha) {
    return { kind: "commit", ref: commits[0].sha.slice(0, 12), date: commits[0].commit?.committer?.date ?? null };
  }
  return null;
}

/**
 * Read an installed package's version by finding its package.json directly
 * (several SDKs' `exports` maps block resolving the `/package.json` subpath),
 * checking workspace-nested installs first, then the hoisted root install.
 */
function findInstalledPkgJson(name) {
  const segs = name.split("/");
  const candidates = [
    join(root, "packages/credentials/node_modules", ...segs, "package.json"),
    join(root, "apps/wallet-demo/node_modules", ...segs, "package.json"),
    // The copy proof-vc-server actually loads (it exact-pins proof-vc-common,
    // so npm may nest a different version than the hoisted/web one).
    join(root, "node_modules/@proof.com/proof-vc-server/node_modules", ...segs, "package.json"),
    join(root, "node_modules", ...segs, "package.json"),
  ];
  for (const p of candidates) {
    try {
      readFileSync(p);
      return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

function readPackageState({ name, declaredIn, specConst }) {
  let declaredRange = null;
  if (declaredIn) {
    try {
      declaredRange = JSON.parse(readFileSync(join(root, declaredIn), "utf8")).dependencies?.[name] ?? null;
    } catch {
      /* reported via installed check below */
    }
  }

  const pkgJsonPath = findInstalledPkgJson(name);
  if (!pkgJsonPath) {
    warnings.push(`installed ${name} not found in node_modules`);
    return { declaredRange, installedVersion: null, specVersion: null };
  }
  const installedVersion = JSON.parse(readFileSync(pkgJsonPath, "utf8")).version ?? null;

  let specVersion = null;
  if (specConst) {
    try {
      const constants = readFileSync(join(dirname(pkgJsonPath), "dist/constants.js"), "utf8");
      specVersion = constants.match(/X401_VERSION\s*=\s*"([^"]+)"/)?.[1] ?? null;
    } catch (err) {
      warnings.push(`could not read X401_VERSION: ${err.message}`);
    }
  }
  return { declaredRange, installedVersion, specVersion };
}

function readLock() {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function sameRef(a, b) {
  if (!a || !b) return false;
  return a.kind === b.kind && a.ref === b.ref;
}

const packages = {};
for (const spec of PACKAGES) {
  const state = readPackageState(spec);
  packages[spec.name] = { ...state, npmLatest: await npmLatest(spec.name) };
}
const repos = {};
for (const { repo } of REPOS) repos[repo] = await githubLatest(repo);

const current = { packages, repos };

if (UPDATE) {
  const lock = {
    _note:
      "Baseline for x401 spec/SDK drift. Regenerate deliberately with `npm run check:x401 -- --update` when you reconcile with a new spec/SDK version. See scripts/check-x401-spec.mjs and docs/X401-PROTOCOL.md.",
    checkedAt: new Date().toISOString(),
    ...current,
  };
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
  console.log(`✓ wrote baseline → ${lockPath}`);
  console.log(fmtState(current));
  process.exit(0);
}

const lock = readLock();
const drift = [];

for (const [name, p] of Object.entries(packages)) {
  // Signal 1: are we behind the published package?
  if (p.npmLatest && p.installedVersion && p.npmLatest !== p.installedVersion) {
    drift.push(`app is behind npm: ${name} installed ${p.installedVersion} < latest ${p.npmLatest}`);
  }
  // Signal 2: has npm moved since our last reconciled baseline?
  const base = lock?.packages?.[name];
  if (p.npmLatest && base?.npmLatest && p.npmLatest !== base.npmLatest) {
    drift.push(`npm latest moved: ${name} ${base.npmLatest} → ${p.npmLatest}`);
  }
}

// Signal 3: have the SDK/spec repos moved since the baseline?
if (lock?.repos) {
  for (const { repo, spec } of REPOS) {
    const cur = repos[repo];
    const base = lock.repos[repo];
    if (cur && base && !sameRef(cur, base)) {
      drift.push(
        `${repo}${spec ? " (SPEC)" : ""} moved: ${refStr(base)} → ${refStr(cur)}${
          spec
            ? " — may not be in the SDK yet; check whether it touches nonce/DC-API request data/Result Artifact (we vendor that layer)"
            : ""
        }`,
      );
    }
  }
}
if (!lock?.packages || !lock?.repos) {
  warnings.push(`no multi-package baseline at ${lockPath} — run \`npm run check:x401 -- --update\` to seed it`);
}

const fetchFailed = warnings.some((w) => /HTTP \d|fetch|ENOTFOUND|ECONN|not resolvable/i.test(w));

if (JSON_OUT) {
  console.log(JSON.stringify({ current, baseline: lock, drift, warnings }, null, 2));
} else {
  console.log(fmtState(current));
  if (warnings.length) {
    console.log("\n⚠ warnings:");
    for (const w of warnings) console.log(`  - ${w}`);
  }
  if (drift.length) {
    console.log("\n✗ DRIFT DETECTED:");
    for (const d of drift) console.log(`  - ${d}`);
    console.log(
      "\nReconcile: review the change, update our wrappers if needed, then\n  npm run check:x401 -- --update\nto move the baseline forward.",
    );
  } else {
    console.log("\n✓ in sync with the recorded baseline.");
  }
}

if (drift.length) process.exit(1);
if (fetchFailed && STRICT) process.exit(1);
process.exit(0);

// --- formatting helpers ---
function refStr(r) {
  return r ? `${r.ref} (${r.kind}${r.date ? `, ${r.date.slice(0, 10)}` : ""})` : "unknown";
}
function fmtState(c) {
  const lines = [];
  for (const [name, p] of Object.entries(c.packages)) {
    lines.push(name);
    lines.push(`  our range   : ${p.declaredRange ?? "(transitive)"}`);
    lines.push(`  installed   : ${p.installedVersion ?? "?"}`);
    if (p.specVersion !== null) lines.push(`  spec const  : X401_VERSION=${p.specVersion}`);
    lines.push(`  npm latest  : ${p.npmLatest ?? "unknown"}`);
  }
  lines.push("repos:");
  for (const { repo, spec } of REPOS) {
    lines.push(`  ${(repo + (spec ? " (SPEC)" : "")).padEnd(28)}: ${refStr(c.repos[repo])}`);
  }
  return lines.join("\n");
}
