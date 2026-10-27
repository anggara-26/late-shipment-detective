// Generates TPC-H with DuckDB's dbgen and registers it in a local Zetaris
// Docker Compose install as the Lightning database TPCH.
// The local zetaris-platform bundle seeds NY_TAXI and TPCDS_DB only.
//
//   npm run load-tpch -- --platform ../zetaris-platform [--sf 0.2]
//   then set ZETARIS_TABLE_PREFIX=TPCH. in .env
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { runSql } from "../src/adapters/zetaris.ts";

const TABLES = ["lineitem", "orders", "supplier", "nation", "region"];
const CONTAINER_DIR = "/home/zetaris/customer-data/shared/tpch";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const platform = path.resolve(arg("platform", process.env.ZETARIS_PLATFORM_DIR ?? "../zetaris-platform")!);
const sf = Number(arg("sf", "0.2"));
if (!fs.existsSync(path.join(platform, "docker-compose.yml"))) {
  console.error(`No docker-compose.yml in ${platform}. Pass --platform <zetaris-platform folder>.`);
  process.exit(1);
}
if (!(sf > 0 && sf <= 10)) {
  console.error(`--sf must be between 0 and 10, got ${arg("sf")}`);
  process.exit(1);
}

const compose = (...args: string[]) =>
  execFileSync("docker", ["compose", ...args], { cwd: platform, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, MSYS_NO_PATHCONV: "1" } });

const out = fs.mkdtempSync(path.join(os.tmpdir(), "tpch-"));
console.log(`1) Generating TPC-H SF${sf} with DuckDB in ${out}`);
const db = await DuckDBInstance.create(":memory:");
const con = await db.connect();
await con.run(`INSTALL tpch; LOAD tpch; CALL dbgen(sf = ${sf});`);
for (const t of TABLES) {
  await con.run(`COPY ${t} TO '${path.join(out, `${t}.parquet`).replace(/\\/g, "/")}' (FORMAT PARQUET)`);
}

console.log(`2) Copying Parquet files into the Zetaris driver (${CONTAINER_DIR})`);
compose("exec", "-T", "driver", "mkdir", "-p", CONTAINER_DIR);
for (const t of TABLES) compose("cp", path.join(out, `${t}.parquet`), `driver:${CONTAINER_DIR}/${t}.parquet`);

console.log("3) Registering Lightning database TPCH");
const ignoreExists = async (sql: string) => {
  try {
    await runSql(sql);
  } catch (err) {
    if (!/already exists/i.test((err as Error).message)) throw err;
    console.log(`   already registered: ${sql.slice(0, 60)}…`);
  }
};
await ignoreExists(`CREATE LIGHTNING DATABASE TPCH DESCRIBE BY "TPC-H SF${sf} generated with DuckDB dbgen"`);
for (const t of TABLES) {
  await ignoreExists(`CREATE LIGHTNING FILESTORE TABLE ${t} FROM TPCH FORMAT PARQUET OPTIONS (PATH "${CONTAINER_DIR}/${t}.parquet")`);
}

const rows = await runSql("SELECT COUNT(*) FROM TPCH.lineitem");
console.log(`✔ TPCH.lineitem has ${rows[0]?.[0]} rows. Set ZETARIS_TABLE_PREFIX=TPCH. in .env`);
fs.rmSync(out, { recursive: true, force: true });
