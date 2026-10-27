// SAMPLE_MODE data source: a small TPC-H-shaped dataset generated in memory
// (SQLite via sql.js, pure WASM) so the project runs without Zetaris.
// It is INPUT data only, generated with the same date rules as TPC-H dbgen:
//   shipdate    = orderdate + U(1,121) days
//   commitdate  = orderdate + U(30,90) days
//   receiptdate = shipdate  + U(1,30)  days
// No answers are stored anywhere; the agents compute everything at run time.
import initSqlJs, { type Database } from "sql.js";

const REGIONS = ["AFRICA", "AMERICA", "ASIA", "EUROPE", "MIDDLE EAST"];
const NATIONS: [string, number][] = [
  ["ALGERIA", 0], ["ARGENTINA", 1], ["BRAZIL", 1], ["CANADA", 1], ["EGYPT", 4], ["ETHIOPIA", 0], ["FRANCE", 3],
  ["GERMANY", 3], ["INDIA", 2], ["INDONESIA", 2], ["IRAN", 4], ["IRAQ", 4], ["JAPAN", 2], ["JORDAN", 4],
  ["KENYA", 0], ["MOROCCO", 0], ["MOZAMBIQUE", 0], ["PERU", 1], ["CHINA", 2], ["ROMANIA", 3], ["SAUDI ARABIA", 4],
  ["VIETNAM", 2], ["RUSSIA", 3], ["UNITED KINGDOM", 3], ["UNITED STATES", 1],
];
const PRIORITIES = ["1-URGENT", "2-HIGH", "3-MEDIUM", "4-NOT SPECIFIED", "5-LOW"];
const MODES = ["REG AIR", "AIR", "RAIL", "SHIP", "TRUCK", "MAIL", "FOB"];
const INSTRUCT = ["DELIVER IN PERSON", "COLLECT COD", "NONE", "TAKE BACK RETURN"];

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);

let dbPromise: Promise<Database> | undefined;

export function sampleDb(): Promise<Database> {
  dbPromise ??= build();
  return dbPromise;
}

async function build(): Promise<Database> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const r = rng(20261027);
  const U = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));

  db.run(`
    CREATE TABLE region (r_regionkey INT, r_name TEXT);
    CREATE TABLE nation (n_nationkey INT, n_name TEXT, n_regionkey INT);
    CREATE TABLE supplier (s_suppkey INT, s_name TEXT, s_nationkey INT);
    CREATE TABLE orders (o_orderkey INT, o_orderdate TEXT, o_orderpriority TEXT);
    CREATE TABLE lineitem (l_orderkey INT, l_suppkey INT, l_quantity INT, l_shipdate TEXT, l_commitdate TEXT,
      l_receiptdate TEXT, l_shipmode TEXT, l_shipinstruct TEXT);
  `);
  db.run("BEGIN");
  REGIONS.forEach((n, i) => db.run("INSERT INTO region VALUES (?,?)", [i, n]));
  NATIONS.forEach(([n, rk], i) => db.run("INSERT INTO nation VALUES (?,?,?)", [i, n, rk]));
  const SUPPLIERS = 200;
  for (let s = 1; s <= SUPPLIERS; s++) db.run("INSERT INTO supplier VALUES (?,?,?)", [s, `Supplier#${String(s).padStart(9, "0")}`, U(0, 24)]);

  const start = Date.UTC(1992, 0, 1);
  const end = Date.UTC(1998, 7, 2) - 151 * DAY;
  const insOrder = db.prepare("INSERT INTO orders VALUES (?,?,?)");
  const insLine = db.prepare("INSERT INTO lineitem VALUES (?,?,?,?,?,?,?,?)");
  for (let o = 1; o <= 6000; o++) {
    const od = start + Math.floor(r() * ((end - start) / DAY)) * DAY;
    insOrder.run([o, fmt(od), PRIORITIES[U(0, 4)]]);
    const lines = U(1, 7);
    for (let l = 0; l < lines; l++) {
      const ship = od + U(1, 121) * DAY;
      const commit = od + U(30, 90) * DAY;
      const receipt = ship + U(1, 30) * DAY;
      insLine.run([o, U(1, SUPPLIERS), U(1, 50), fmt(ship), fmt(commit), fmt(receipt), MODES[U(0, 6)], INSTRUCT[U(0, 3)]]);
    }
  }
  insOrder.free();
  insLine.free();
  db.run("COMMIT");
  return db;
}

export async function runSampleSql(sql: string): Promise<unknown[][]> {
  const db = await sampleDb();
  const res = db.exec(sql);
  return res.length ? (res[0].values as unknown[][]) : [];
}
