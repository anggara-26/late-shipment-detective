// Orchestration. The whole investigation runs as ONE Markovian run:
//   chunk 1      Planner decomposes the question  -> carryover lists REMAINING hypotheses
//   chunk 2..k   one hypothesis per chunk: Retriever -> Analyst <-> Skeptic -> Planner revises
//   last chunk   Writer drafts, Skeptic audits every number, Writer revises if needed -> [TASK_COMPLETE]
// Each chunk only sees the goal + the compressed carryover block (COMPLETED / REMAINING /
// DECISIONS / CONTEXT), so the context the Planner reads stays flat however many
// hypotheses are tested. Full evidence lives in a shared evidence store the Writer reads.
import { config } from "./config.ts";
import { dialect, runSql, sourceName } from "./adapters/zetaris.ts";
import { baselineSql, dimension, pct, type Filters } from "./analysis.ts";
import {
  allowedNumbers, analystInterpret, auditNumbers, OFFLINE, parseHypothesis, plannerPlan, plannerRevise, retrieverFetch,
  skepticVerify, writerCompose, type Evidence, type Report, type Verdict,
} from "./agents.ts";
import { canonicalBlock, carryoverFromPrompt, estimateTokens, Markovian } from "./engines/markovian/index.ts";
import { Tracer } from "./tracing.ts";
import path from "node:path";
import { ROOT } from "./config.ts";

export interface InvestigationInput {
  question: string;
  filters?: Filters;
}

const field = (block: string, name: string): string => block.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1]?.trim() ?? "";
const list = (s: string): string[] => (!s || s === "none" ? [] : s.split(",").map((x) => x.trim()).filter(Boolean));

export async function investigate(input: InvestigationInput, opts: { quiet?: boolean } = {}) {
  if (!input?.question || typeof input.question !== "string") throw new Error('input must be {"question": string, "filters"?: {...}}');
  const tracer = new Tracer({ quiet: opts.quiet });
  const started = Date.now();
  if (!opts.quiet) console.log(`\n▶ ${input.question}\n  trace ${tracer.traceId} · data: ${sourceName()} · models: ${config.llmOffline ? OFFLINE : "Meterless Nightshift"}\n`);

  // Shared state the agents read and write (the Writer reads it at the end).
  const evidence: Evidence[] = [];
  let filters: Filters = {};
  let baseline = { n: 0, late: 0, rate: 0 };
  let report: (Report & { model: string }) | undefined;
  let auditRevisions = 0;
  const models = new Set<string>();
  const contextPerStep: { step: number; planner_context_tokens: number; naive_history_tokens: number }[] = [];

  const engine = new Markovian({
    chunkConfig: { chunkSize: 4000, carryoverTokens: 384, maxChunks: Math.min(32, config.maxHypotheses + 6) },
    historyDir: path.join(ROOT, "logs", "markovian-history"),
  });

  const generator = async (prompt: string): Promise<{ text: string }> => {
    const carry = carryoverFromPrompt(prompt);

    // ---- chunk 1: planning ----
    if (!carry) {
      const plan = await plannerPlan(tracer, input.question, input.filters);
      models.add(plan.model);
      filters = plan.filters;
      const rows = await runSql(baselineSql(dialect(), { filters }));
      baseline = { n: Number(rows[0]?.[0] ?? 0), late: Number(rows[0]?.[1] ?? 0), rate: 0 };
      baseline.rate = pct(baseline.late, baseline.n);
      tracer.log({
        agent_name: "RetrieverAgent",
        action: "query_zetaris",
        input_summary: `baseline for scope ${JSON.stringify(filters)}`,
        output_summary: `${baseline.late} of ${baseline.n} line items late (${baseline.rate}%)`,
        target_agent: "PlannerAgent",
        status: baseline.n > 0 ? "success" : "error",
      });
      if (baseline.n === 0) throw new Error(`No line items match scope ${JSON.stringify(filters)}`);
      return {
        text:
          `Plan: ${plan.rationale}\n\n[STATE_CHECKPOINT]\n` +
          canonicalBlock({
            completed: "none",
            remaining: plan.hypotheses.join(", "),
            decisions: `scope ${JSON.stringify(filters)}; baseline ${baseline.rate}% late of ${baseline.n} line items`,
            context: `question: ${input.question.slice(0, 160)}`,
          }),
      };
    }

    const completed = list(field(carry, "COMPLETED"));
    const remaining = list(field(carry, "REMAINING"));
    const decisions = field(carry, "DECISIONS");
    const context = field(carry, "CONTEXT");

    // ---- final chunk: write + audit ----
    if (!remaining.length) {
      const allowed = allowedNumbers(evidence, baseline.rate);
      report = await writerCompose(tracer, input.question, filters, evidence, baseline.rate);
      models.add(report.model);
      let bad = auditNumbers(`${report.summary}\n${report.report_markdown}`, allowed);
      if (bad.length) {
        auditRevisions++;
        const fb = `these numbers are not in the verified evidence: ${bad.join(", ")}. Use only evidence numbers.`;
        tracer.log({ agent_name: "SkepticAgent", action: "audit_report", input_summary: "final draft", output_summary: fb, target_agent: "WriterAgent", status: "needs_revision" });
        report = await writerCompose(tracer, input.question, filters, evidence, baseline.rate, fb);
        models.add(report.model);
        bad = auditNumbers(`${report.summary}\n${report.report_markdown}`, allowed);
      }
      tracer.log({
        agent_name: "SkepticAgent",
        action: "audit_report",
        input_summary: "final draft",
        output_summary: bad.length ? `approved with warning: unverified numbers ${bad.join(", ")}` : "every number traces to verified evidence — approved",
        target_agent: "APIResponse",
        status: bad.length ? "partial_success" : "success",
      });
      return { text: `${report.summary}\n\n[TASK_COMPLETE]` };
    }

    // ---- investigation chunk: test ONE hypothesis ----
    const key = remaining[0];
    const rest = remaining.slice(1);
    const h = parseHypothesis(key);
    let verdict: Verdict;
    let note: string;
    if (!h) {
      verdict = { key, verdict: "INCONCLUSIVE", reason: "unknown hypothesis key", confidence: 0, spreadPp: 0, p: 1 };
      note = `Skipped ${key}`;
    } else {
      const r = await retrieverFetch(tracer, h, filters);
      if (!r || r.buckets.length === 0) {
        verdict = { key, verdict: "INCONCLUSIVE", reason: "data unavailable after retry", confidence: 0, spreadPp: 0, p: 1 };
        note = `${key}: data unavailable`;
      } else {
        let claim = await analystInterpret(tracer, h, r.buckets);
        models.add(claim.model);
        verdict = await skepticVerify(tracer, h, filters, r, claim);
        // Critique loop: the Skeptic may send the claim back (max 2 rounds), then decides.
        for (let round = 0; verdict.verdict === "SEND_BACK" && round < 2; round++) {
          claim = await analystInterpret(tracer, h, r.buckets, verdict.reason);
          models.add(claim.model);
          verdict = await skepticVerify(tracer, h, filters, r, claim);
        }
        if (verdict.verdict === "SEND_BACK") verdict = { ...verdict, verdict: "INCONCLUSIVE", reason: `Analyst could not produce a verifiable claim (${verdict.reason})` };
        const dim = dimension(h.dimension)!;
        evidence.push({
          key, label: dim.label, hypothesis: dim.hypothesis, within: h.within, verdict: verdict.verdict, reason: verdict.reason,
          claim: claim.claim, buckets: r.buckets, spreadPp: verdict.spreadPp, p: verdict.p, sql: r.sql, narrowed: r.narrowed,
        });
        note = `${key}: ${verdict.verdict} — ${claim.claim}\n${r.buckets.map((b) => `| ${b.bucket} | ${b.late}/${b.n} | ${b.rate}% |`).join("\n")}`;
      }
    }

    const newCompleted = [...completed, `${key}=${verdict.verdict}(${verdict.spreadPp}pp)`];
    const block = (rem: string[]) =>
      canonicalBlock({ completed: newCompleted.join(", "), remaining: rem.join(", ") || "none", decisions, context });
    const tested = [...new Set([...completed.map((c) => c.replace(/=(SUPPORTED|REJECTED|INCONCLUSIVE)\(.*$/, "")), key])];
    const revision = await plannerRevise(tracer, block(rest), rest, tested, verdict);
    // Context accounting: the Planner read only the carryover block, not every table so far.
    const naive = estimateTokens(JSON.stringify(evidence.map((e) => ({ k: e.key, c: e.claim, b: e.buckets }))) + prompt);
    contextPerStep.push({ step: tested.length, planner_context_tokens: estimateTokens(prompt), naive_history_tokens: naive });
    return { text: `${note}\n\n[STATE_CHECKPOINT]\n${block(revision.remaining)}` };
  };

  const run = await engine.run({ goal: `Explain: ${input.question}`, generator, reflect: false });
  if (run.status !== "completed" || !report) throw new Error(`investigation did not complete (${run.status}${run.error ? `: ${run.error}` : ""})`);

  const sendBacks = tracer.events.filter((e) => e.status === "needs_revision").length;
  const result = {
    trace_id: tracer.traceId,
    question: input.question,
    scope: filters,
    data_source: sourceName(),
    answer: {
      summary: report.summary,
      supported: evidence.filter((e) => e.verdict === "SUPPORTED").map(view),
      ruled_out: evidence.filter((e) => e.verdict === "REJECTED").map(view),
      inconclusive: evidence.filter((e) => e.verdict === "INCONCLUSIVE").map(view),
      recommended_actions: report.recommended_actions,
      limitations: [
        "Findings show association, not proven causation.",
        `Scope: ${baseline.n} line items${config.sampleMode ? " from the synthetic SAMPLE_MODE dataset" : " in Zetaris (TPC-H)"}.`,
      ],
      report_markdown: report.report_markdown,
    },
    baseline,
    collaboration: {
      hypotheses_tested: evidence.length,
      skeptic_send_backs: sendBacks,
      skeptic_rejections: evidence.filter((e) => e.verdict === "REJECTED").length,
      report_audit_revisions: auditRevisions,
      retries: tracer.events.filter((e) => e.status === "retrying").length,
    },
    markovian: {
      run_id: run.id,
      status: run.status,
      chunks: run.chunks.length,
      carryover_tokens_budget: run.chunkConfig.carryoverTokens,
      tokens_used_estimated: run.totalTokensUsed,
      tokens_saved_estimated: run.totalTokensSaved,
      efficiency_percent: Math.round(run.efficiencyPercent * 10) / 10,
      final_carryover: run.finalCarryover,
      context_per_step: contextPerStep,
    },
    models_used: [...models],
    duration_ms: Date.now() - started,
    log_path: path.relative(ROOT, tracer.file),
  };
  return result;
}

function view(e: Evidence) {
  return {
    factor: e.key,
    label: e.label,
    claim: e.claim,
    skeptic: e.reason,
    spread_pp: e.spreadPp,
    p_value: Number(e.p.toPrecision(3)),
    buckets: e.buckets,
    narrowed_query: e.narrowed,
  };
}
