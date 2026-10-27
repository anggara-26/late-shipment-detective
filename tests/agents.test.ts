// Unit + end-to-end tests. Run offline on the synthetic sample: `npm test`.
process.env.SAMPLE_MODE = "true";
process.env.LLM_OFFLINE = "true";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { chiSquare, toBuckets } = await import("../src/analysis.ts");
const { auditNumbers, groundedWordingIssue, parseHypothesis, skepticVerify, retrieverFetch } = await import("../src/agents.ts");
const { investigate } = await import("../src/orchestrator.ts");
const { Tracer } = await import("../src/tracing.ts");
const { ROOT } = await import("../src/config.ts");

test("chi-square: identical rates are not significant, very different rates are", () => {
  const same = toBuckets([["a", 1000, 500], ["b", 1000, 500]]);
  const diff = toBuckets([["a", 1000, 100], ["b", 1000, 900]]);
  assert.ok(chiSquare(same).p > 0.5);
  assert.ok(chiSquare(diff).p < 1e-6);
});

test("report audit flags numbers that are not in the evidence", () => {
  assert.deepEqual(auditNumbers("late rate is 63.9% and 12.0 pp", [63.9, 12]), []);
  assert.deepEqual(auditNumbers("late rate is 70%", [63.9]), [70]);
});

test("report audit accepts whole-number rounding of an evidence number, not other integers", () => {
  assert.deepEqual(auditNumbers("the 71-90d band is 46% late", [46.2]), []);
  assert.deepEqual(auditNumbers("the 71-90d band is 47% late", [46.2]), [47]);
});

test("Skeptic only keeps a wording objection it can ground in the claim", () => {
  const buckets = toBuckets([["01-30d", 1000, 90], ["91d+", 1000, 1000]]);
  const llmSaysNo = { ok: false, issue: "'associated with' is causal language" };
  assert.equal(groundedWordingIssue("Dispatch lag is associated with lateness: 9% for 01-30d vs 100% for 91d+.", buckets, llmSaysNo), undefined);
  assert.match(groundedWordingIssue("Long dispatch lag causes late deliveries (100% for 91d+).", buckets, llmSaysNo) ?? "", /causal/);
  assert.match(groundedWordingIssue("Dispatch lag is associated with lateness: 75% for 91d+.", buckets, { ok: true, issue: "" }) ?? "", /75/);
});

test("Skeptic sends back a claim whose numbers do not match its own recount", async () => {
  const tracer = new Tracer({ quiet: true });
  const h = parseHypothesis("ship_mode")!;
  const r = await retrieverFetch(tracer, h, { region: "ASIA" });
  assert.ok(r && r.buckets.length > 1);
  const real = [...r.buckets].sort((a, b) => b.rate - a.rate);
  const fake = { claim: "AIR is late far more often", top_bucket: real[0].bucket, top_rate: real[0].rate + 15, bottom_bucket: real.at(-1)!.bucket, bottom_rate: real.at(-1)!.rate };
  const v = await skepticVerify(tracer, h, { region: "ASIA" }, r, fake);
  assert.equal(v.verdict, "SEND_BACK");
  assert.ok(tracer.events.some((e) => e.agent_name === "SkepticAgent" && e.status === "needs_revision"));
});

test("end to end: agents collaborate, different questions give different answers, logs prove it", async () => {
  const a = await investigate({ question: "Why are shipments from ASIA suppliers late?" }, { quiet: true });
  const b = await investigate({ question: "Why are GERMANY suppliers late in 1996?" }, { quiet: true });
  assert.notDeepEqual(a.scope, b.scope);
  assert.notEqual(a.baseline.n, b.baseline.n);
  const log = fs.readFileSync(path.join(ROOT, a.log_path), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  const agents = new Set(log.map((e) => e.agent_name));
  for (const name of ["PlannerAgent", "RetrieverAgent", "AnalystAgent", "SkepticAgent", "WriterAgent"]) assert.ok(agents.has(name), `missing ${name}`);
  assert.ok(log.some((e) => e.agent_name === "SkepticAgent" && e.status === "rejected"), "Skeptic should reject at least one suspect");
  assert.ok(log.some((e) => e.agent_name === "PlannerAgent" && e.action === "revise_plan"), "Planner should revise after verdicts");
  assert.equal(a.markovian.status, "completed");
  assert.ok(a.markovian.chunks >= 3);
});

test("runtime code never reads saved output examples", () => {
  for (const f of fs.readdirSync(path.join(ROOT, "src"), { recursive: true }) as string[]) {
    if (!f.endsWith(".ts")) continue;
    assert.ok(!fs.readFileSync(path.join(ROOT, "src", f), "utf-8").includes("output_examples"), `${f} references output_examples`);
  }
});
