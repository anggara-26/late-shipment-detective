// The five agents. Each has one job and its own authority:
//   Planner   - turns the question into testable hypotheses; revises the plan after every verdict
//   Retriever - queries Zetaris; retries with a lighter query when a query fails
//   Analyst   - reads the numbers and states a claim
//   Skeptic   - re-queries Zetaris independently, recounts what the Analyst quoted, tests significance,
//               and can send the claim back or reject it outright
//   Writer    - writes the final explanation from VERIFIED evidence only; the Skeptic audits it
// All model calls go through Meterless Nightshift; each has a deterministic fallback
// that is used (and logged as "offline-fallback") only when Nightshift is unavailable.
import { config } from "./config.ts";
import { chat, parseJson } from "./adapters/nightshift.ts";
import { dialect, runSql, ZetarisError } from "./adapters/zetaris.ts";
import {
  baselineSql, breakdownSql, bucketSql, chiSquare, DIMENSIONS, dimension, NATIONS, pct, REGIONS, RULES, toBuckets,
  type Bucket, type Filters, type Scope,
} from "./analysis.ts";
import type { Tracer } from "./tracing.ts";

export const OFFLINE = "offline-fallback";

/** Call Nightshift and parse JSON; fall back to deterministic logic if the provider is unavailable. */
async function think<T>(
  tracer: Tracer,
  agent: string,
  system: string,
  user: string,
  fallback: () => T,
  opts: { deep?: boolean; validate?: (v: T) => T } = {},
): Promise<{ value: T; model: string }> {
  if (!config.llmOffline) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await chat(
          [
            { role: "system", content: system + "\nReply with ONE JSON object only, no prose outside it." },
            { role: "user", content: user },
          ],
          { deep: opts.deep },
        );
        const parsed = parseJson<T>(r.content);
        return { value: opts.validate ? opts.validate(parsed) : parsed, model: r.model };
      } catch (err) {
        tracer.log({
          agent_name: agent,
          action: "model_call_failed",
          input_summary: "Nightshift chat completion",
          output_summary: (err as Error).message.slice(0, 160),
          target_agent: agent,
          status: attempt === 0 ? "retrying" : "fallback",
          retry_count: attempt,
        });
      }
    }
  }
  return { value: fallback(), model: OFFLINE };
}

// ---------------- hypotheses ----------------

/** "ship_mode" or a drill-down "supplier_nation@dispatch_lag=91d+". */
export interface Hypothesis {
  key: string;
  dimension: string;
  within?: { dimension: string; bucket: string };
}

export function parseHypothesis(key: string): Hypothesis | undefined {
  const m = key.trim().match(/^([a-z_]+)(?:@([a-z_]+)=(.+))?$/);
  if (!m || !dimension(m[1])) return undefined;
  if (m[2] && !dimension(m[2])) return undefined;
  return { key: key.trim(), dimension: m[1], within: m[2] ? { dimension: m[2], bucket: m[3].trim() } : undefined };
}

const catalogText = DIMENSIONS.map((d) => `- ${d.id}: ${d.hypothesis}`).join("\n");

// ---------------- Planner ----------------

export interface Plan {
  filters: Filters;
  hypotheses: string[];
  rationale: string;
}

function cleanFilters(f: Filters | undefined): Filters {
  const out: Filters = {};
  const region = f?.region?.toUpperCase();
  const nation = f?.nation?.toUpperCase();
  if (region && REGIONS.includes(region)) out.region = region;
  if (nation && NATIONS.includes(nation)) out.nation = nation;
  if (f?.yearFrom && f.yearFrom >= 1992 && f.yearFrom <= 1998) out.yearFrom = Math.trunc(f.yearFrom);
  if (f?.yearTo && f.yearTo >= 1992 && f.yearTo <= 1998) out.yearTo = Math.trunc(f.yearTo);
  return out;
}

function filtersFromText(q: string): Filters {
  const up = q.toUpperCase();
  const f: Filters = {};
  const region = REGIONS.find((r) => up.includes(r));
  const nation = NATIONS.find((n) => up.includes(n));
  if (region) f.region = region;
  if (nation) f.nation = nation;
  const years = [...up.matchAll(/\b(199[2-8])\b/g)].map((m) => Number(m[1]));
  if (years.length) {
    f.yearFrom = Math.min(...years);
    f.yearTo = Math.max(...years);
  }
  return f;
}

export async function plannerPlan(tracer: Tracer, question: string, given: Filters | undefined): Promise<Plan & { model: string }> {
  const fallback = (): Plan => {
    const filters = { ...filtersFromText(question), ...cleanFilters(given) };
    const order = ["ship_mode", "supplier_region", "order_priority", "dispatch_lag", "transit_time", "commit_window", "ship_instruction", "quantity"];
    const hypotheses = order.filter((id) => !(id === "supplier_region" && (filters.region || filters.nation))).slice(0, config.maxHypotheses);
    return { filters, hypotheses, rationale: "Default order: common business suspects first, then process timing." };
  };
  const { value, model } = await think<Plan>(
    tracer,
    "PlannerAgent",
    "You are the Planner in an investigation team that explains why shipments arrive late (receipt date after the committed date). " +
      "You turn a manager's question into testable hypotheses from a fixed catalog. You never answer the question yourself.",
    `Question: ${question}\nExplicit scope from the user: ${JSON.stringify(given ?? {})}\n\nHypothesis catalog (use these ids only):\n${catalogText}\n\n` +
      `Allowed regions: ${REGIONS.join(", ")}. Allowed nations: ${NATIONS.join(", ")}. Data covers 1992-1998.\n` +
      `Return {"filters": {"region"?: string, "nation"?: string, "yearFrom"?: number, "yearTo"?: number}, "hypotheses": [ids, most promising first, max ${config.maxHypotheses}], "rationale": string}. ` +
      "Include both business suspects (mode, region, priority) and process-timing suspects (dispatch_lag, transit_time, commit_window).",
    fallback,
    {
      validate: (p) => {
        const hyps = (p.hypotheses ?? []).filter((h) => parseHypothesis(h));
        if (!hyps.length) throw new Error("planner returned no valid hypotheses");
        return { filters: { ...cleanFilters(p.filters), ...cleanFilters(given) }, hypotheses: [...new Set(hyps)].slice(0, config.maxHypotheses), rationale: String(p.rationale ?? "") };
      },
    },
  );
  tracer.log({
    agent_name: "PlannerAgent",
    action: "decompose_question",
    input_summary: question.slice(0, 120),
    output_summary: `${value.hypotheses.length} hypotheses: ${value.hypotheses.join(", ")}; scope ${JSON.stringify(value.filters)}`,
    target_agent: "RetrieverAgent",
    status: "success",
    model,
  });
  return { ...value, model };
}

export interface Revision {
  remaining: string[];
  rationale: string;
}

/** The Planner sees ONLY the Markovian carryover block, not the full history. */
export async function plannerRevise(tracer: Tracer, carryover: string, remaining: string[], tested: string[], lastVerdict: Verdict): Promise<Revision> {
  const budget = Math.max(0, config.maxHypotheses + 2 - tested.length);
  const fallback = (): Revision => ({ remaining: remaining.slice(0, budget), rationale: "Continue with the planned order." });
  const { value, model } = await think<Revision>(
    tracer,
    "PlannerAgent",
    "You are the Planner. After each verdict from the Skeptic you decide what to test next. " +
      "If a factor was SUPPORTED you may add ONE drill-down written as '<dimension>@<supported_dimension>=<worst_bucket>' to check whether the effect is concentrated somewhere. " +
      "If a factor was REJECTED, do not retry it. Never re-test a key that is already completed.",
    `[CARRYOVER STATE]\n${carryover}\n\nLatest verdict: ${lastVerdict.key} = ${lastVerdict.verdict} (${lastVerdict.reason})\n` +
      `Catalog:\n${catalogText}\nAlready tested: ${tested.join(", ")}\nYou may plan at most ${budget} more tests.\n` +
      `Return {"remaining": [keys in order], "rationale": string}.`,
    fallback,
    {
      validate: (r) => {
        const keys = (r.remaining ?? []).filter((k) => parseHypothesis(k) && !tested.includes(k));
        return { remaining: [...new Set(keys)].slice(0, budget), rationale: String(r.rationale ?? "") };
      },
    },
  );
  tracer.log({
    agent_name: "PlannerAgent",
    action: "revise_plan",
    input_summary: `Skeptic: ${lastVerdict.key} ${lastVerdict.verdict}`,
    output_summary: value.remaining.length ? `next: ${value.remaining.join(", ")} — ${value.rationale.slice(0, 120)}` : "no further tests needed",
    target_agent: value.remaining.length ? "RetrieverAgent" : "WriterAgent",
    status: "success",
    model,
  });
  return value;
}

// ---------------- Retriever ----------------

export interface Retrieved {
  buckets: Bucket[];
  sql: string;
  narrowed: boolean;
}

export async function retrieverFetch(tracer: Tracer, h: Hypothesis, filters: Filters): Promise<Retrieved | undefined> {
  const dim = dimension(h.dimension)!;
  for (const narrowed of [false, true]) {
    const scope: Scope = { filters, within: h.within, narrowed };
    const sql = breakdownSql(dialect(), dim, scope);
    const t0 = Date.now();
    try {
      const buckets = toBuckets(await runSql(sql));
      tracer.log({
        agent_name: "RetrieverAgent",
        action: "query_zetaris",
        input_summary: `${h.key}${narrowed ? " (narrowed to 1997+)" : ""}`,
        output_summary: `${buckets.length} buckets, ${buckets.reduce((s, b) => s + b.n, 0)} line items`,
        target_agent: "AnalystAgent",
        status: "success",
        sql,
        retry_count: narrowed ? 1 : 0,
        duration_ms: Date.now() - t0,
      });
      return { buckets, sql, narrowed };
    } catch (err) {
      const e = err as ZetarisError;
      tracer.log({
        agent_name: "RetrieverAgent",
        action: "query_zetaris",
        input_summary: h.key,
        output_summary: `${e.message.slice(0, 160)}${narrowed ? "" : " — retrying with a lighter query"}`,
        target_agent: narrowed ? "PlannerAgent" : "RetrieverAgent",
        status: narrowed ? "error" : "retrying",
        sql,
        retry_count: narrowed ? 1 : 0,
        duration_ms: Date.now() - t0,
      });
    }
  }
  return undefined;
}

// ---------------- Analyst ----------------

export interface Claim {
  claim: string;
  top_bucket: string;
  top_rate: number;
  bottom_bucket: string;
  bottom_rate: number;
}

const table = (b: Bucket[]) => b.map((x) => `${x.bucket}: ${x.late}/${x.n} late = ${x.rate}%`).join("\n");

export async function analystInterpret(tracer: Tracer, h: Hypothesis, buckets: Bucket[], feedback?: string): Promise<Claim & { model: string }> {
  const dim = dimension(h.dimension)!;
  const fallback = (): Claim => {
    const sorted = [...buckets].sort((a, b) => b.rate - a.rate);
    const top = sorted[0];
    const bottom = sorted[sorted.length - 1];
    return {
      claim: `Late rate by ${dim.label.toLowerCase()} ranges from ${bottom.rate}% (${bottom.bucket}) to ${top.rate}% (${top.bucket}).`,
      top_bucket: top.bucket,
      top_rate: top.rate,
      bottom_bucket: bottom.bucket,
      bottom_rate: bottom.rate,
    };
  };
  const { value, model } = await think<Claim>(
    tracer,
    "AnalystAgent",
    "You are the Analyst. You read a breakdown table and state ONE claim about whether this factor is associated with late deliveries. " +
      "Quote numbers exactly as they appear in the table. Say 'associated with', never 'causes'.",
    `Hypothesis: ${dim.hypothesis}${h.within ? ` (only rows where ${h.within.dimension} = ${h.within.bucket})` : ""}\n` +
      `Breakdown of late line items by ${dim.label}:\n${table(buckets)}\n` +
      (feedback ? `\nThe Skeptic sent your previous claim back: ${feedback}\nFix it.\n` : "") +
      `Return {"claim": string, "top_bucket": string, "top_rate": number, "bottom_bucket": string, "bottom_rate": number} where top = highest late rate, bottom = lowest.`,
    fallback,
    {
      validate: (c) => {
        if (!c || typeof c.claim !== "string" || !c.top_bucket || !c.bottom_bucket) throw new Error("analyst reply missing fields");
        return { ...c, top_rate: Number(c.top_rate), bottom_rate: Number(c.bottom_rate) };
      },
    },
  );
  tracer.log({
    agent_name: "AnalystAgent",
    action: feedback ? "revise_claim" : "interpret_breakdown",
    input_summary: `${h.key}, ${buckets.length} buckets`,
    output_summary: value.claim.slice(0, 180),
    target_agent: "SkepticAgent",
    status: "success",
    model,
  });
  return { ...value, model };
}

// ---------------- Skeptic ----------------

export interface Verdict {
  key: string;
  verdict: "SUPPORTED" | "REJECTED" | "INCONCLUSIVE" | "SEND_BACK";
  reason: string;
  confidence: number;
  spreadPp: number;
  p: number;
  baseline?: { n: number; late: number; rate: number };
  recount?: { bucket: string; n: number; late: number; rate: number }[];
}

async function count(sql: string): Promise<{ n: number; late: number }> {
  const rows = await runSql(sql);
  return { n: Number(rows[0]?.[0] ?? 0), late: Number(rows[0]?.[1] ?? 0) };
}

export async function skepticVerify(tracer: Tracer, h: Hypothesis, filters: Filters, r: Retrieved, claim: Claim): Promise<Verdict> {
  const dim = dimension(h.dimension)!;
  const scope: Scope = { filters, within: h.within, narrowed: r.narrowed };
  const base: Verdict = { key: h.key, verdict: "INCONCLUSIVE", reason: "", confidence: 0.5, spreadPp: 0, p: 1 };

  // 1. Independent recount through Zetaris: baseline + the two buckets the Analyst cited.
  let baseline;
  const recount: NonNullable<Verdict["recount"]> = [];
  try {
    const b = await count(baselineSql(dialect(), scope));
    baseline = { ...b, rate: pct(b.late, b.n) };
    for (const bucket of [claim.top_bucket, claim.bottom_bucket]) {
      const c = await count(bucketSql(dialect(), dim, scope, bucket));
      recount.push({ bucket, ...c, rate: pct(c.late, c.n) });
    }
  } catch (err) {
    const v = { ...base, reason: `could not verify: ${(err as Error).message.slice(0, 120)}` };
    tracer.log({ agent_name: "SkepticAgent", action: "verify_claim", input_summary: h.key, output_summary: v.reason, target_agent: "PlannerAgent", status: "error" });
    return v;
  }
  tracer.log({
    agent_name: "SkepticAgent",
    action: "independent_recount",
    input_summary: `recount ${claim.top_bucket}, ${claim.bottom_bucket} + baseline via Zetaris`,
    output_summary: `baseline ${baseline.rate}% of ${baseline.n}; ${recount.map((x) => `${x.bucket}=${x.rate}% (n=${x.n})`).join(", ")}`,
    target_agent: "SkepticAgent",
    status: "success",
  });

  // 2. Did the Analyst quote the numbers correctly?
  const quoted = [
    { bucket: claim.top_bucket, rate: claim.top_rate },
    { bucket: claim.bottom_bucket, rate: claim.bottom_rate },
  ];
  const misquotes = quoted.filter((q, i) => recount[i].n === 0 || Math.abs(recount[i].rate - q.rate) > RULES.quoteTolerancePp);
  if (misquotes.length) {
    const reason = misquotes
      .map((q) => {
        const rc = recount.find((x) => x.bucket === q.bucket);
        return rc && rc.n > 0 ? `${q.bucket} is ${rc.rate}%, not ${q.rate}%` : `bucket "${q.bucket}" does not exist in the data`;
      })
      .join("; ");
    const v: Verdict = { ...base, verdict: "SEND_BACK", reason: `numbers do not match the recount: ${reason}`, baseline, recount };
    tracer.log({ agent_name: "SkepticAgent", action: "reject_misquote", input_summary: claim.claim.slice(0, 120), output_summary: v.reason, target_agent: "AnalystAgent", status: "needs_revision" });
    return v;
  }

  // 3. Is the factor meaningful? Effect size + significance + sample size.
  const stats = chiSquare(r.buckets);
  const rates = r.buckets.map((b) => b.rate);
  const spreadPp = Math.round((Math.max(...rates) - Math.min(...rates)) * 10) / 10;
  const smallest = Math.min(...r.buckets.map((b) => b.n));
  let v: Verdict;
  if (r.buckets.length < 2 || smallest < RULES.minBucketN) {
    v = { ...base, verdict: "INCONCLUSIVE", reason: `too little data (smallest bucket n=${smallest})`, confidence: 0.4, spreadPp, p: stats.p };
  } else if (stats.p < RULES.maxP && spreadPp >= RULES.minSpreadPp) {
    v = { ...base, verdict: "SUPPORTED", reason: `${spreadPp} pp gap between buckets, p=${stats.p.toExponential(1)}`, confidence: Math.min(0.97, 0.7 + spreadPp / 100), spreadPp, p: stats.p };
  } else {
    v = {
      ...base,
      verdict: "REJECTED",
      reason: spreadPp < RULES.minSpreadPp ? `only ${spreadPp} pp between best and worst bucket — no meaningful difference` : `gap not significant (p=${stats.p.toFixed(3)})`,
      confidence: 0.85,
      spreadPp,
      p: stats.p,
    };
  }
  v.baseline = baseline;
  v.recount = recount;

  // 4. For supported claims, the Skeptic (deep lane) also challenges the wording.
  if (v.verdict === "SUPPORTED") {
    const fallback = () => ({ ok: true, issue: "" });
    const { value, model } = await think<{ ok: boolean; issue: string }>(
      tracer,
      "SkepticAgent",
      "You are the Skeptic. Check a claim for overclaiming: causal language ('causes', 'because', 'due to'), or numbers not in the evidence. " +
        "'Associated with' and 'correlated with' are the correct, non-causal wording. Citing only the highest and lowest bucket is fine. Be strict but fair.",
      `Claim: ${claim.claim}\nEvidence table:\n${table(r.buckets)}\nReturn {"ok": boolean, "issue": string}.`,
      fallback,
      { deep: true },
    );
    const issue = groundedWordingIssue(claim.claim, r.buckets, value);
    if (issue) {
      v.verdict = "SEND_BACK";
      v.reason = `wording: ${issue}`;
      tracer.log({ agent_name: "SkepticAgent", action: "challenge_wording", input_summary: claim.claim.slice(0, 120), output_summary: v.reason, target_agent: "AnalystAgent", status: "needs_revision", model });
      return v;
    }
  }

  tracer.log({
    agent_name: "SkepticAgent",
    action: "verdict",
    input_summary: `${h.key}: ${claim.claim.slice(0, 100)}`,
    output_summary: `${v.verdict}: ${v.reason}`,
    target_agent: "PlannerAgent",
    status: v.verdict === "SUPPORTED" ? "success" : v.verdict === "REJECTED" ? "rejected" : "partial_success",
    confidence: v.confidence,
  });
  return v;
}

// ---------------- Writer + final audit ----------------

export interface Evidence {
  key: string;
  label: string;
  hypothesis: string;
  within?: { dimension: string; bucket: string };
  verdict: Verdict["verdict"];
  reason: string;
  claim: string;
  buckets: Bucket[];
  spreadPp: number;
  p: number;
  sql: string;
  narrowed: boolean;
}

export interface Report {
  summary: string;
  recommended_actions: string[];
  report_markdown: string;
}

const numbersIn = (s: string) => [...s.matchAll(/(\d+(?:\.\d+)?)\s?(?:%|pp)/g)].map((m) => Number(m[1]));

export function allowedNumbers(evidence: Evidence[], baselineRate: number): number[] {
  const out = [baselineRate];
  for (const e of evidence) {
    out.push(e.spreadPp);
    for (const b of e.buckets) out.push(b.rate);
  }
  return out;
}

export function auditNumbers(text: string, allowed: number[]): number[] {
  // A whole number may be the rounded form of an evidence number (46% for 46.2%).
  const matches = (n: number, a: number) => Math.abs(a - n) <= 0.15 || (Number.isInteger(n) && Math.round(a) === n);
  return numbersIn(text).filter((n) => !allowed.some((a) => matches(n, a)));
}

const CAUSAL = /\b(cause[sd]?|causing|because|due to|proves?|leads? to|drives?)\b/i;

/**
 * The model's wording objection is only kept when a checkable rule backs it:
 * causal language in the claim, or a quoted rate that is not in the evidence.
 */
export function groundedWordingIssue(claim: string, buckets: Bucket[], llm: { ok: boolean; issue: string }): string | undefined {
  const unknown = auditNumbers(claim, buckets.map((b) => b.rate));
  if (unknown.length) return `numbers not in the evidence: ${unknown.join(", ")}`;
  if (CAUSAL.test(claim)) return llm.ok ? "claim uses causal language; the data only shows association" : llm.issue;
  return undefined;
}

export async function writerCompose(
  tracer: Tracer,
  question: string,
  filters: Filters,
  evidence: Evidence[],
  baselineRate: number,
  feedback?: string,
): Promise<Report & { model: string }> {
  const supported = evidence.filter((e) => e.verdict === "SUPPORTED");
  const rejected = evidence.filter((e) => e.verdict === "REJECTED");
  const unknown = evidence.filter((e) => e.verdict === "INCONCLUSIVE");
  const line = (e: Evidence) =>
    `${e.label}${e.within ? ` (within ${e.within.dimension}=${e.within.bucket})` : ""}: ${e.buckets.map((b) => `${b.bucket} ${b.rate}%`).join(", ")} — ${e.reason}`;

  const fallback = (): Report => {
    const top = [...supported].sort((a, b) => b.spreadPp - a.spreadPp)[0];
    const summary = top
      ? `${baselineRate}% of line items in scope arrived after the committed date. The strongest factor is ${top.label.toLowerCase()}: ${top.buckets.map((b) => `${b.bucket} ${b.rate}%`).join(", ")}. ` +
        (rejected.length ? `${rejected.map((e) => e.label).join(", ")} were checked and ruled out.` : "")
      : `None of the ${evidence.length} tested factors explains late deliveries (${baselineRate}% late overall); ${rejected.map((e) => e.label).join(", ")} were ruled out.`;
    const actions = top
      ? [`Investigate the ${top.label.toLowerCase()} bucket with the highest late rate first.`, "Track this factor weekly so the team sees whether fixes reduce the late rate."]
      : ["Do not act on the usual suspects; collect additional data (e.g. warehouse events) before changing suppliers or carriers."];
    const md = [
      `## Answer\n${summary}`,
      `## Supported\n${supported.map((e) => `- ${line(e)}`).join("\n") || "- none"}`,
      `## Ruled out by the Skeptic\n${rejected.map((e) => `- ${line(e)}`).join("\n") || "- none"}`,
      `## Inconclusive\n${unknown.map((e) => `- ${line(e)}`).join("\n") || "- none"}`,
      `## Recommended actions\n${actions.map((a) => `- ${a}`).join("\n")}`,
    ].join("\n\n");
    return { summary, recommended_actions: actions, report_markdown: md };
  };

  const { value, model } = await think<Report>(
    tracer,
    "WriterAgent",
    "You are the Writer. You explain to an operations manager why deliveries are late, using ONLY the verified evidence given. " +
      "Lead with the answer. Mention which suspects were ruled out (that saves the manager from wrong decisions). " +
      "Use only numbers that appear in the evidence. Say 'associated with', not 'causes'. Recommend 2-3 concrete actions.",
    `Question: ${question}\nScope: ${JSON.stringify(filters)}\nOverall late rate in scope: ${baselineRate}%\n\n` +
      `SUPPORTED:\n${supported.map(line).join("\n") || "none"}\n\nRULED OUT:\n${rejected.map(line).join("\n") || "none"}\n\nINCONCLUSIVE:\n${unknown.map(line).join("\n") || "none"}\n` +
      (feedback ? `\nThe Skeptic rejected your previous draft: ${feedback}\n` : "") +
      `\nReturn {"summary": string (2-3 sentences), "recommended_actions": [string], "report_markdown": string}.`,
    fallback,
    {
      deep: true,
      validate: (r) => {
        if (!r.summary || !r.report_markdown) throw new Error("writer reply missing fields");
        return { summary: String(r.summary), recommended_actions: (r.recommended_actions ?? []).map(String), report_markdown: String(r.report_markdown) };
      },
    },
  );
  tracer.log({
    agent_name: "WriterAgent",
    action: feedback ? "revise_report" : "draft_report",
    input_summary: `${supported.length} supported, ${rejected.length} ruled out, ${unknown.length} inconclusive`,
    output_summary: value.summary.slice(0, 180),
    target_agent: "SkepticAgent",
    status: "success",
    model,
  });
  return { ...value, model };
}
