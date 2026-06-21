/**
 * Minimal .env loader for the runnable entry points (merchant, agent, setup
 * scripts). Deliberately does NOT override variables already present in the
 * environment, so inline `VAR=x npm run …` still wins over the file. No-ops if
 * the file is absent (e.g. in tests).
 */
import { readFileSync } from "node:fs";

export function loadEnv(path = ".env"): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (!key || process.env[key] !== undefined) continue;
    let value = (match[2] ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
