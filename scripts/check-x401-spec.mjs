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
 *
 * This script polls three independent signals and compares them to a committed
 * baseline (`x401-spec.lock.json`):
 *   1. npm latest of @proof.com/x401-node   → "are we behind the SDK?"
 *   2. proof/x401-node latest release/tag    → "did the SDK repo ship something?"
 *   3. proof/x401 latest release/tag/commit  → "did the SPEC move?" (may or may
 *                                               not be in the SDK yet)
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

const PKG = "@proof.com/x401-node";
const REPO_SDK = "proof/x401-node";
const REPO_SPEC = "proof/x401";
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
async function npmLatest() {
  const meta = await getJson(`https://registry.npmjs.org/${PKG}`, "npm registry");
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
 * Read our installed SDK: package version, spec version const, declared range.
 * Reads the package.json directly (the SDK's `exports` map blocks resolving the
 * `/package.json` subpath), checking the workspace-nested install first, then a
 * hoisted root install.
 */
function readInstalled() {
  const candidates = [
    join(root, "packages/credentials/node_modules", ...PKG.split("/"), "package.json"),
    join(root, "node_modules", ...PKG.split("/"), "package.json"),
  ];
  const pkgJsonPath = candidates.find((p) => {
    try {
      readFileSync(p);
      return true;
    } catch {
      return false;
    }
  });
  if (!pkgJsonPath) {
    warnings.push(`installed ${PKG} not found (looked in ${candidates.join(", ")})`);
    return { installedVersion: null, specVersion: null };
  }
  const installedVersion = JSON.parse(readFileSync(pkgJsonPath, "utf8")).version ?? null;

  let specVersion = null;
  try {
    const constants = readFileSync(join(dirname(pkgJsonPath), "dist/constants.js"), "utf8");
    specVersion = constants.match(/X401_VERSION\s*=\s*"([^"]+)"/)?.[1] ?? null;
  } catch (err) {
    warnings.push(`could not read X401_VERSION: ${err.message}`);
  }
  return { installedVersion, specVersion };
}

function readDeclaredRange() {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "packages/credentials/package.json"), "utf8"));
    return pkg.dependencies?.[PKG] ?? null;
  } catch {
    return null;
  }
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

const { installedVersion, specVersion } = readInstalled();
const declaredRange = readDeclaredRange();
const [npm, sdkRepo, specRepo] = await Promise.all([
  npmLatest(),
  githubLatest(REPO_SDK),
  githubLatest(REPO_SPEC),
]);

const current = {
  app: { declaredRange, installedVersion, specVersion },
  upstream: { npmLatest: npm, x401NodeLatest: sdkRepo, x401SpecLatest: specRepo },
};

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

// Signal 1: are we behind the published SDK?
if (npm && installedVersion && npm !== installedVersion) {
  drift.push(`app is behind npm: installed ${installedVersion} < latest ${npm} (bump ${PKG})`);
}

// Signals 2 & 3: has upstream moved since our last reconciled baseline?
if (lock) {
  if (npm && lock.upstream?.npmLatest && npm !== lock.upstream.npmLatest) {
    drift.push(`npm latest moved: ${lock.upstream.npmLatest} → ${npm}`);
  }
  if (sdkRepo && lock.upstream?.x401NodeLatest && !sameRef(sdkRepo, lock.upstream.x401NodeLatest)) {
    drift.push(`${REPO_SDK} moved: ${refStr(lock.upstream.x401NodeLatest)} → ${refStr(sdkRepo)}`);
  }
  if (specRepo && lock.upstream?.x401SpecLatest && !sameRef(specRepo, lock.upstream.x401SpecLatest)) {
    drift.push(
      `${REPO_SPEC} (SPEC) moved: ${refStr(lock.upstream.x401SpecLatest)} → ${refStr(specRepo)} — may not be in the SDK yet; check whether it touches nonce/DC-API request data/Result Artifact (we vendor that layer)`,
    );
  }
} else {
  warnings.push(`no baseline at ${lockPath} — run \`npm run check:x401 -- --update\` to seed it`);
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
  return [
    `${PKG}`,
    `  our range        : ${c.app.declaredRange ?? "?"}`,
    `  installed (npm)  : ${c.app.installedVersion ?? "?"}`,
    `  spec impl const  : X401_VERSION=${c.app.specVersion ?? "?"}`,
    `  npm latest       : ${c.upstream.npmLatest ?? "unknown"}`,
    `  ${REPO_SDK.padEnd(15)}: ${refStr(c.upstream.x401NodeLatest)}`,
    `  ${REPO_SPEC.padEnd(15)}: ${refStr(c.upstream.x401SpecLatest)}`,
  ].join("\n");
}
