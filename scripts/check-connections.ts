// npm run check — verifies the two required sponsor connections before a run.
import { config } from "../src/config.ts";
import { chat, nightshiftStatus } from "../src/adapters/nightshift.ts";
import { runSql, t } from "../src/adapters/zetaris.ts";

console.log(`SAMPLE_MODE=${config.sampleMode}  LLM_OFFLINE=${config.llmOffline}\n`);

console.log(`1) Zetaris (${config.sampleMode ? "sample data" : config.zetaris.restUrl}, mode=${config.zetaris.mode}, prefix="${config.zetaris.tablePrefix}")`);
try {
  console.log(`   SELECT 1 → ${JSON.stringify(await runSql("SELECT 1 AS one"))}`);
  const rows = await runSql(`SELECT COUNT(*) FROM ${t("lineitem")}`);
  console.log(`   ${t("lineitem")} rows → ${rows[0]?.[0]}  ✔`);
} catch (err) {
  console.log(`   ✖ ${(err as Error).message}\n   Tip: run \`npm run discover\` to find the TPC-H table prefix.`);
}

console.log(`\n2) Meterless Nightshift (${config.meterless.baseUrl}, model=${config.meterless.model})`);
const s = await nightshiftStatus();
console.log(`   status: ${s.status}${s.detail ? ` (${s.detail})` : ""}`);
if (s.models.length) console.log(`   models: ${s.models.slice(0, 12).join(", ")}`);
if (s.status === "online") {
  try {
    const r = await chat([{ role: "user", content: "Reply with the single word: ready" }]);
    console.log(`   test request → "${r.content.slice(0, 40)}" handled by model: ${r.model}  ✔`);
  } catch (err) {
    console.log(`   ✖ ${(err as Error).message}`);
  }
}
