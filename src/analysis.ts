// Hypothesis catalog, SQL builders and statistics. The SQL is generated from a
// fixed catalog (not free-form LLM SQL) so every query is valid in both the
// Zetaris (Spark/Lightning SQL) and SAMPLE_MODE (SQLite) dialects.
import { t, type Dialect } from "./adapters/zetaris.ts";

export const REGIONS = ["AFRICA", "AMERICA", "ASIA", "EUROPE", "MIDDLE EAST"];
export const NATIONS = [
  "ALGERIA", "ARGENTINA", "BRAZIL", "CANADA", "EGYPT", "ETHIOPIA", "FRANCE", "GERMANY", "INDIA", "INDONESIA", "IRAN", "IRAQ",
  "JAPAN", "JORDAN", "KENYA", "MOROCCO", "MOZAMBIQUE", "PERU", "CHINA", "ROMANIA", "SAUDI ARABIA", "VIETNAM", "RUSSIA",
  "UNITED KINGDOM", "UNITED STATES",
];

export interface Filters {
  region?: string;
  nation?: string;
  yearFrom?: number;
  yearTo?: number;
}

const days = (d: Dialect, a: string, b: string) => (d === "spark" ? `datediff(${a}, ${b})` : `CAST(julianday(${a}) - julianday(${b}) AS INTEGER)`);
const bucket = (expr: string, edges: [number, number, string][], last: string) =>
  `CASE ${edges.map(([lo, hi, label]) => `WHEN ${expr} BETWEEN ${lo} AND ${hi} THEN '${label}'`).join(" ")} ELSE '${last}' END`;

export interface Dimension {
  id: string;
  label: string;
  /** What a business user would call this hypothesis. */
  hypothesis: string;
  expr: (d: Dialect) => string;
}

export const DIMENSIONS: Dimension[] = [
  { id: "ship_mode", label: "Ship mode", hypothesis: "Some shipping modes (AIR, RAIL, TRUCK...) are late more often", expr: () => "l.l_shipmode" },
  { id: "supplier_region", label: "Supplier region", hypothesis: "Suppliers in some regions deliver late more often", expr: () => "r.r_name" },
  { id: "supplier_nation", label: "Supplier nation", hypothesis: "Suppliers in some countries deliver late more often", expr: () => "n.n_name" },
  { id: "order_priority", label: "Order priority", hypothesis: "Low-priority orders are late more often than urgent ones", expr: () => "o.o_orderpriority" },
  { id: "ship_instruction", label: "Shipping instruction", hypothesis: "Certain shipping instructions (COD, in-person...) cause delays", expr: () => "l.l_shipinstruct" },
  {
    id: "dispatch_lag",
    label: "Dispatch lag (order → ship, days)",
    hypothesis: "Items leave the warehouse too long after the order is placed",
    expr: (d) => bucket(days(d, "l.l_shipdate", "o.o_orderdate"), [[0, 30, "01-30d"], [31, 60, "31-60d"], [61, 90, "61-90d"]], "91d+"),
  },
  {
    id: "transit_time",
    label: "Transit time (ship → receipt, days)",
    hypothesis: "The carrier journey itself takes too long",
    expr: (d) => bucket(days(d, "l.l_receiptdate", "l.l_shipdate"), [[0, 10, "01-10d"], [11, 20, "11-20d"]], "21-30d"),
  },
  {
    id: "commit_window",
    label: "Promised window (order → committed date, days)",
    hypothesis: "Delivery promises are set too tight",
    expr: (d) => bucket(days(d, "l.l_commitdate", "o.o_orderdate"), [[0, 50, "30-50d"], [51, 70, "51-70d"]], "71-90d"),
  },
  {
    id: "quantity",
    label: "Line quantity",
    hypothesis: "Large quantities take longer and arrive late",
    expr: () => bucket("l.l_quantity", [[1, 10, "01-10"], [11, 25, "11-25"], [26, 40, "26-40"]], "41-50"),
  },
];

export const dimension = (id: string): Dimension | undefined => DIMENSIONS.find((d) => d.id === id);

const LATE = "CASE WHEN l.l_receiptdate > l.l_commitdate THEN 1 ELSE 0 END";

function from(): string {
  return (
    `FROM ${t("lineitem")} l JOIN ${t("orders")} o ON l.l_orderkey = o.o_orderkey ` +
    `JOIN ${t("supplier")} s ON l.l_suppkey = s.s_suppkey JOIN ${t("nation")} n ON s.s_nationkey = n.n_nationkey ` +
    `JOIN ${t("region")} r ON n.n_regionkey = r.r_regionkey`
  );
}

export interface Scope {
  filters: Filters;
  /** Optional drill-down: only rows where another dimension equals a bucket. */
  within?: { dimension: string; bucket: string };
  /** Retry fallback: restrict to recent orders to make the query lighter. */
  narrowed?: boolean;
}

function where(d: Dialect, s: Scope, extra?: string): string {
  const c: string[] = [];
  const f = s.filters;
  if (f.region && REGIONS.includes(f.region)) c.push(`r.r_name = '${f.region}'`);
  if (f.nation && NATIONS.includes(f.nation)) c.push(`n.n_name = '${f.nation}'`);
  if (f.yearFrom && Number.isInteger(f.yearFrom)) c.push(`o.o_orderdate >= '${f.yearFrom}-01-01'`);
  if (f.yearTo && Number.isInteger(f.yearTo)) c.push(`o.o_orderdate <= '${f.yearTo}-12-31'`);
  if (s.within) {
    const wd = dimension(s.within.dimension);
    if (wd) c.push(`${wd.expr(d)} = '${s.within.bucket.replace(/'/g, "")}'`);
  }
  if (s.narrowed) c.push(`o.o_orderdate >= '1997-01-01'`);
  if (extra) c.push(extra);
  return c.length ? `WHERE ${c.join(" AND ")}` : "";
}

/** Retriever query: late rate per bucket of one dimension. Columns: bucket, n, late. */
export function breakdownSql(d: Dialect, dim: Dimension, s: Scope): string {
  const e = dim.expr(d);
  return `SELECT ${e} AS bucket, COUNT(*) AS n, SUM(${LATE}) AS late ${from()} ${where(d, s)} GROUP BY ${e} ORDER BY ${e}`;
}

/** Skeptic query 1: independent baseline over the whole scope. Columns: n, late. */
export function baselineSql(d: Dialect, s: Scope): string {
  return `SELECT COUNT(*) AS n, SUM(${LATE}) AS late ${from()} ${where(d, s)}`;
}

/** Skeptic query 2: independently recount one bucket the Analyst cited. Columns: n, late. */
export function bucketSql(d: Dialect, dim: Dimension, s: Scope, bucketValue: string): string {
  return `SELECT COUNT(*) AS n, SUM(${LATE}) AS late ${from()} ${where(d, s, `${dim.expr(d)} = '${bucketValue.replace(/'/g, "")}'`)}`;
}

// ---------- statistics ----------

export interface Bucket {
  bucket: string;
  n: number;
  late: number;
  rate: number; // percent, 1 decimal
}

export const pct = (late: number, n: number): number => (n > 0 ? Math.round((late / n) * 1000) / 10 : 0);

export function toBuckets(rows: unknown[][]): Bucket[] {
  return rows
    .map((r) => ({ bucket: String(r[0]), n: Number(r[1]), late: Number(r[2]) }))
    .filter((b) => b.n > 0)
    .map((b) => ({ ...b, rate: pct(b.late, b.n) }));
}

/** Chi-square test of independence (k buckets × late/on-time). */
export function chiSquare(buckets: Bucket[]): { chi2: number; df: number; p: number } {
  const N = buckets.reduce((s, b) => s + b.n, 0);
  const L = buckets.reduce((s, b) => s + b.late, 0);
  if (N === 0 || L === 0 || L === N || buckets.length < 2) return { chi2: 0, df: Math.max(1, buckets.length - 1), p: 1 };
  let chi2 = 0;
  for (const b of buckets) {
    const eLate = (b.n * L) / N;
    const eOn = (b.n * (N - L)) / N;
    chi2 += (b.late - eLate) ** 2 / eLate + (b.n - b.late - eOn) ** 2 / eOn;
  }
  const df = buckets.length - 1;
  return { chi2, df, p: 1 - lowerGammaRegularized(df / 2, chi2 / 2) };
}

function lowerGammaRegularized(s: number, x: number): number {
  if (x <= 0) return 0;
  if (x > s + 40) return 1; // far tail; p effectively 0
  let sum = 1 / s;
  let term = 1 / s;
  for (let k = 1; k < 500; k++) {
    term *= x / (s + k);
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return Math.min(1, Math.exp(-x + s * Math.log(x) - logGamma(s)) * sum);
}

function logGamma(z: number): number {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const tt = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(tt) - tt + Math.log(x);
}

export const RULES = {
  /** Minimum percentage-point gap between best and worst bucket to call a factor meaningful. */
  minSpreadPp: 5,
  /** Significance threshold. */
  maxP: 0.001,
  /** Buckets smaller than this make the test inconclusive. */
  minBucketN: 30,
  /** Allowed gap between a number the Analyst quotes and the Skeptic's recount. */
  quoteTolerancePp: 0.2,
};
