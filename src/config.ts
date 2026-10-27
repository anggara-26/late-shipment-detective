// Loads .env (no extra dependency) and exposes typed settings.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnv(): void {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv();

const env = (k: string, d = ""): string => (process.env[k] ?? d).trim();
const bool = (k: string, d: boolean): boolean => {
  const v = env(k);
  return v ? v.toLowerCase() === "true" : d;
};

export const config = {
  /** SAMPLE_MODE=true swaps Zetaris for a local TPC-H-shaped sample (input data only). */
  sampleMode: bool("SAMPLE_MODE", false),
  /** LLM_OFFLINE=true uses deterministic fallbacks when Nightshift is not available. */
  llmOffline: bool("LLM_OFFLINE", false),

  zetaris: {
    // "api"  -> http://localhost:8888/api/v1.0 + POST /sql-editor/sqls/run   (Participant Setup Guide 1.9)
    // "proxy"-> http://localhost:3000          + POST /api/proxy/sql-editor/sqls/run-query (getting-started scripts)
    mode: env("ZETARIS_MODE", "api") as "api" | "proxy",
    restUrl: env("ZETARIS_REST_URL", "http://localhost:8888/api/v1.0").replace(/\/$/, ""),
    orgId: env("ZETARIS_ORG_ID", "1"),
    apiKey: env("ZETARIS_API_KEY"),
    /** Prefix in front of TPC-H table names, e.g. "tpch." -> tpch.lineitem. Find it with `npm run discover`. */
    tablePrefix: env("ZETARIS_TABLE_PREFIX", ""),
    timeoutMs: Number(env("ZETARIS_TIMEOUT_MS", "120000")),
  },

  meterless: {
    baseUrl: normalizeBase(env("METERLESS_BASE_URL", "http://127.0.0.1:8088/v1")),
    token: env("METERLESS_RUNTIME_TOKEN"),
    /** Routing mode or a concrete model id from Nightshift (e.g. a Nemotron id). */
    model: env("METERLESS_MODEL", "meterless/auto"),
    /** Optional second lane for the Skeptic/Writer, e.g. meterless/deep or a larger Nemotron. */
    deepModel: env("METERLESS_DEEP_MODEL", ""),
    app: "late-shipment-detective",
    timeoutMs: Number(env("METERLESS_TIMEOUT_MS", "180000")),
  },

  maxHypotheses: Number(env("MAX_HYPOTHESES", "6")),
};

/** Normalize a pasted Nightshift URL to <origin>/v1 (never /v1/v1). */
export function normalizeBase(url: string): string {
  const u = url.replace(/\/+$/, "").replace(/(\/v1)+$/, "");
  return `${u}/v1`;
}
