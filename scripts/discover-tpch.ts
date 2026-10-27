// npm run discover — finds where the TPC-H sample tables live in your Zetaris
// install and prints the ZETARIS_TABLE_PREFIX to put in .env.
import { config } from "../src/config.ts";
import { runSql } from "../src/adapters/zetaris.ts";

if (config.sampleMode) {
  console.log("SAMPLE_MODE=true — discovery only applies to a live Zetaris. Set SAMPLE_MODE=false.");
  process.exit(0);
}
for (const sql of ["SHOW LIGHTNING DATABASES", "SHOW DATABASES"]) {
  try {
    console.log(`${sql}:\n  ${(await runSql(sql)).map((r) => r.join(" | ")).join("\n  ")}`);
    break;
  } catch (err) {
    console.log(`${sql}: ${(err as Error).message.slice(0, 120)}`);
  }
}
const candidates = ["", "tpch.", "TPCH.", "tpch.tpch.", "tpch_sf1.", "tpch.sf1.", "tpch.tiny.", "tpch_db.", "sample.tpch.", "default."];
for (const p of candidates) {
  try {
    const rows = await runSql(`SELECT COUNT(*) FROM ${p}lineitem`);
    console.log(`\n✔ Found TPC-H: ${p}lineitem has ${rows[0]?.[0]} rows.\n  Put this in .env:  ZETARIS_TABLE_PREFIX=${p}`);
    process.exit(0);
  } catch {
    console.log(`  ✖ ${p || "(no prefix)"}lineitem`);
  }
}
console.log("\nNot found automatically. Open the Zetaris SQL Editor (http://localhost:3000), browse the databases for 'lineitem', and set ZETARIS_TABLE_PREFIX accordingly (e.g. mydb.myschema.).");
