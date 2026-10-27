// Zetaris adapter: the agents' only path to data. Sends one SQL statement per
// request to the Zetaris REST API and returns rows (array of arrays, in the
// SELECT's column order). In SAMPLE_MODE the same SQL runs against the local
// TPC-H-shaped sample instead (SQLite dialect).
import crypto from "node:crypto";
import { config } from "../config.ts";
import { runSampleSql } from "./sampleData.ts";

export type Dialect = "spark" | "sqlite";

export class ZetarisError extends Error {
  constructor(message: string, readonly kind: "timeout" | "http" | "unreachable" | "sql") {
    super(message);
  }
}

export const dialect = (): Dialect => (config.sampleMode ? "sqlite" : "spark");
export const sourceName = (): string => (config.sampleMode ? "sample-tpch (SAMPLE_MODE)" : "zetaris");

/** Fully qualified table name, e.g. tpch.lineitem. */
export const t = (name: string): string => (config.sampleMode ? name : `${config.zetaris.tablePrefix}${name}`);

export async function runSql(sql: string, limit = 1000): Promise<unknown[][]> {
  if (config.sampleMode) {
    try {
      return await runSampleSql(sql);
    } catch (err) {
      throw new ZetarisError((err as Error).message, "sql");
    }
  }
  if (!config.zetaris.apiKey) throw new ZetarisError("ZETARIS_API_KEY is not set (create one in the Zetaris web UI).", "http");

  const url =
    config.zetaris.mode === "proxy"
      ? `${config.zetaris.restUrl}/api/proxy/sql-editor/sqls/run-query`
      : `${config.zetaris.restUrl}/sql-editor/sqls/run`;
  const body =
    config.zetaris.mode === "proxy"
      ? { sql, limit }
      : { queryId: crypto.randomUUID(), sql, source: "SqlEditor", limit };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.zetaris.apiKey}`,
        "X-Org-ID": config.zetaris.orgId,
        "X-Request-ID": crypto.randomUUID(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.zetaris.timeoutMs),
    });
  } catch (err) {
    const e = err as Error;
    if (e.name === "TimeoutError") throw new ZetarisError(`Zetaris query timed out after ${config.zetaris.timeoutMs} ms`, "timeout");
    throw new ZetarisError(`Cannot reach Zetaris at ${config.zetaris.restUrl}: ${e.message}`, "unreachable");
  }
  const text = await res.text();
  if (!res.ok) throw new ZetarisError(`Zetaris HTTP ${res.status}: ${text.slice(0, 400)}`, res.status >= 500 ? "sql" : "http");
  const out = text ? JSON.parse(text) : null;
  return extractRows(out);
}

/** Zetaris returns rows under `data` (array of arrays); accept a few shapes defensively. */
export function extractRows(out: unknown): unknown[][] {
  const pick = (o: any): unknown => o?.data ?? o?.rows ?? o?.result?.data ?? o?.result?.rows ?? o;
  const rows = pick(out);
  if (!Array.isArray(rows)) throw new ZetarisError(`Unexpected Zetaris response shape: ${JSON.stringify(out).slice(0, 300)}`, "sql");
  return rows.map((r) => (Array.isArray(r) ? r : typeof r === "object" && r !== null ? Object.values(r) : [r]));
}
