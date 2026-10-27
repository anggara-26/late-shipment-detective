// Markovian engine (Meterless engine spec: engines/markovian/AGENTS.md).
//
// Our own TypeScript implementation of the Markovian chunked-reasoning
// contract. A long task runs as a chain of bounded chunks; each chunk sees
// only the goal plus a compressed CARRYOVER block from the previous chunk,
// so per-step context stays flat instead of growing with the history.
//
// In this project every chunk is one investigation cycle (one hypothesis
// tested against Zetaris), and the carryover block is the investigation
// state the agents hand forward. Verified with the official Meterless
// conformance suite: `npm run test:markovian`.

import fs from "node:fs";
import path from "node:path";

// ---------- canonical shapes (spec section 2) ----------

export interface ChunkConfig {
  chunkSize: number;
  maxChunks: number;
  carryoverTokens: number;
  overlapTokens: number;
}

export const DEFAULT_CONFIG: ChunkConfig = { chunkSize: 8000, maxChunks: 24, carryoverTokens: 800, overlapTokens: 0 };

export const BOUNDS = {
  chunkSize: { min: 1000, max: 128000 },
  maxChunks: { min: 1, max: 32 },
  carryoverTokens: { min: 128, max: 32768 },
  overlapTokens: { min: 0, max: 4096 },
} as const;

export const FRAMING_TOKENS = 400;
export const OUTPUT_BUDGET = 1200;

/** Token estimate used everywhere: ceil(chars / 4). Labelled "estimated". */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(`Markovian config: ${message}`);
    this.name = "ConfigValidationError";
  }
}

export interface ChunkInfo {
  id: number;
  tokens: number;
  carryover: string;
  content: string;
}

export type RunStatus = "completed" | "max-chunks" | "errored" | "aborted";

export interface MarkovianRun {
  id: string;
  timestamp: number;
  prompt: string;
  mode: "ARCHITECT" | "RESEARCH";
  chunkConfig: ChunkConfig;
  chunks: ChunkInfo[];
  totalTokensUsed: number;
  totalTokensSaved: number;
  efficiencyPercent: number;
  durationMs: number;
  status: RunStatus;
  tokenLabel: "estimated" | "measured";
  output: string;
  finalCarryover: string;
  reflection?: string;
  error?: string;
}

export type Generator = (prompt: string, attachments?: unknown[], systemPrompt?: string) => Promise<{ text: string }>;

export interface RunOptions {
  goal?: string;
  prompt?: string;
  mode?: "ARCHITECT" | "RESEARCH";
  generator?: Generator;
  memoryContext?: string;
  reflect?: boolean;
  abortSignal?: AbortSignal;
}

export interface MarkovianOptions {
  chunkConfig?: Partial<ChunkConfig>;
  generator?: Generator;
  compressorFn?: (prompt: string, systemPrompt: string) => Promise<string>;
  clock?: () => number;
  historyDir?: string;
}

// ---------- config + efficiency math (spec sections 2.1, 6) ----------

export function resolveConfig(partial?: Partial<ChunkConfig>): ChunkConfig {
  const cfg: ChunkConfig = { ...DEFAULT_CONFIG, ...partial };
  for (const key of Object.keys(BOUNDS) as (keyof ChunkConfig)[]) {
    const v = cfg[key];
    const b = BOUNDS[key];
    if (!Number.isFinite(v)) throw new ConfigValidationError(`${key} must be a number`);
    // Out-of-range values are rejected with a typed error, never clamped.
    if (v < b.min || v > b.max) throw new ConfigValidationError(`${key}=${v} outside [${b.min}, ${b.max}]`);
  }
  if (cfg.chunkSize < FRAMING_TOKENS + cfg.carryoverTokens + OUTPUT_BUDGET) {
    throw new ConfigValidationError(
      `chunkSize=${cfg.chunkSize} is smaller than framing(${FRAMING_TOKENS}) + carryover(${cfg.carryoverTokens}) + output(${OUTPUT_BUDGET})`,
    );
  }
  return cfg;
}

/** Efficiency of a recorded run, always against that run's own config snapshot. */
export function runEfficiency(chunks: ChunkInfo[], cfg: ChunkConfig) {
  const totalTokensUsed = chunks.reduce((s, c) => s + c.tokens, 0);
  let standardCost = 0;
  let history = 0;
  for (const c of chunks) {
    standardCost += history + c.tokens; // naive prompting re-sends all prior output
    history += c.tokens;
  }
  const markovianCost = chunks.length * cfg.carryoverTokens + totalTokensUsed;
  const tokensSaved = Math.max(0, standardCost - markovianCost);
  return {
    totalTokensUsed,
    standardCost,
    markovianCost,
    tokensSaved,
    efficiencyPercent: standardCost > 0 ? (tokensSaved / standardCost) * 100 : 0,
  };
}

/** Symbolic cost model (docs/efficiency-model.md): F framing, G goal, S step input, O output, C carryover. */
export function modelTotals(N: number, k = { F: 400, G: 200, S: 300, O: 1200, C: 800 }) {
  const naiveTotal = N * (k.F + k.G + k.S) + (k.O * N * (N - 1)) / 2;
  const markovianTotal = N * (k.F + k.G + k.C + k.S);
  const savings = naiveTotal - markovianTotal;
  return { naiveTotal, markovianTotal, savings, efficiency: savings / naiveTotal };
}

// ---------- marker protocol (spec section 3) ----------

const STATE_TAIL = [/\[STATE_CHECKPOINT\]\s*([\s\S]*)$/, /@@@STATE@@@\s*([\s\S]*)$/, /---STATE---\s*([\s\S]*)$/];
const FINAL = [/\[TASK_COMPLETE\]/, /@@@FINAL@@@/, /---FINAL---/];

export function parseMarkers(raw: string): { state?: string; done: boolean; cleaned: string } {
  let state: string | undefined;
  for (const re of STATE_TAIL) {
    const m = raw.match(re);
    if (m) {
      state = m[1].replace(/\[TASK_COMPLETE\]/g, "").trim();
      break;
    }
  }
  return { state, done: FINAL.some((re) => re.test(raw)), cleaned: cleanMarkers(raw) };
}

export function cleanMarkers(raw: string): string {
  let out = raw;
  for (const re of [/\[STATE_CHECKPOINT\][\s\S]*$/, /@@@STATE@@@[\s\S]*$/, /---STATE---[\s\S]*$/]) out = out.replace(re, "");
  for (const re of [/\[TASK_COMPLETE\]/g, /@@@FINAL@@@/g, /---FINAL---/g]) out = out.replace(re, "");
  return out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function canonicalBlock(p: { completed: string; remaining: string; decisions: string; context: string }): string {
  return `COMPLETED: ${p.completed}\nREMAINING: ${p.remaining}\nDECISIONS: ${p.decisions}\nCONTEXT: ${p.context}`;
}

// ---------- carryover compression cascade (spec section 4.3) ----------

async function nextCarryover(args: {
  markerState?: string;
  previous: string;
  chunkText: string;
  budget: number;
  compressorFn?: MarkovianOptions["compressorFn"];
}): Promise<{ carryover: string; level: "marker" | "llm" | "heuristic" | "truncation" }> {
  // 1. explicit state block from the chunk, if it fits the budget
  if (args.markerState && args.markerState.length >= 24 && estimateTokens(args.markerState) <= args.budget) {
    return { carryover: args.markerState, level: "marker" };
  }
  // 2. LLM compression
  if (args.compressorFn) {
    try {
      const c = (
        await args.compressorFn(
          `Previous state:\n${args.previous || "(none)"}\n\nLatest chunk (tail):\n${args.chunkText.slice(-2000)}\n\n` +
            "Compress into a labeled block:\nCOMPLETED: ...\nREMAINING: ...\nDECISIONS: ...\nCONTEXT: ...",
          "You compress reasoning state. Be terse and lossless on decisions.",
        )
      ).trim();
      if (c.length >= 24 && estimateTokens(c) <= args.budget) return { carryover: c, level: "llm" };
    } catch {
      /* fall through */
    }
  }
  // 3. heuristic: keep the labeled lines we can find
  const labeled = args.chunkText.match(/^(COMPLETED|REMAINING|DECISIONS|CONTEXT|Decision|Next|Status):.*$/gim);
  if (labeled?.length) {
    const s = labeled.join("\n");
    if (estimateTokens(s) <= args.budget) return { carryover: s, level: "heuristic" };
  }
  // 4. tail truncation to the budget
  const source = args.markerState || args.chunkText || args.previous;
  return { carryover: source.slice(-args.budget * 4), level: "truncation" };
}

// ---------- prompt builder (spec section 4.4) ----------

const MARKER_RULES =
  "End every non-final chunk with [STATE_CHECKPOINT] followed by:\nCOMPLETED: ...\nREMAINING: ...\nDECISIONS: ...\nCONTEXT: ...\n" +
  "End the final chunk with [TASK_COMPLETE]. Exactly one marker per chunk.";

export function buildPrompt(a: { goal: string; step: number; carryover: string; overlap: string; memoryContext?: string; mode: string }): string {
  const parts: string[] = [];
  if (a.step === 1) {
    if (a.memoryContext) parts.push(a.memoryContext.trim(), "");
    parts.push(`You are executing a ${a.mode.toLowerCase()} task in bounded chunks.`, "", `User Request: ${a.goal}`);
  } else {
    parts.push(`Continuing a chunked ${a.mode.toLowerCase()} run. Goal (truncated): ${a.goal.slice(0, 200)}`, "");
    parts.push(`[CARRYOVER STATE]\n${a.carryover}`);
    if (a.overlap) parts.push("", `[OVERLAP]\n${a.overlap}`);
    parts.push("", "Continue exactly where the state leaves off. Do not repeat completed work.");
  }
  parts.push("", MARKER_RULES);
  return parts.join("\n");
}

/** Pull the carryover block back out of a built prompt (used by step generators). */
export function carryoverFromPrompt(prompt: string): string {
  const m = prompt.match(/\[CARRYOVER STATE\]\n([\s\S]*?)(?:\n\n|$)/);
  return m ? m[1].trim() : "";
}

// ---------- engine ----------

let runSeq = 0;

export class Markovian {
  readonly config: ChunkConfig;
  private clock: () => number;
  private history: MarkovianRun[] = [];
  private historyFile?: string;

  constructor(private opts: MarkovianOptions = {}) {
    this.config = resolveConfig(opts.chunkConfig);
    this.clock = opts.clock ?? Date.now;
    if (opts.historyDir) {
      fs.mkdirSync(opts.historyDir, { recursive: true });
      this.historyFile = path.join(opts.historyDir, "history.json");
      if (fs.existsSync(this.historyFile)) this.history = JSON.parse(fs.readFileSync(this.historyFile, "utf-8"));
    }
  }

  runs(): readonly MarkovianRun[] {
    return this.history;
  }

  async run(options: RunOptions): Promise<MarkovianRun> {
    const goal = options.goal ?? options.prompt;
    if (!goal) throw new Error("Markovian: run needs a goal");
    const generator = options.generator ?? this.opts.generator;
    if (!generator) throw new Error("Markovian: provide a generator");
    const mode = options.mode ?? "RESEARCH";
    const cfg = this.config;
    const start = this.clock();
    const run: MarkovianRun = {
      id: `markovian-${++runSeq}-${start}`,
      timestamp: start,
      prompt: goal.slice(0, 500),
      mode,
      chunkConfig: { ...cfg }, // mandatory per-run snapshot
      chunks: [],
      totalTokensUsed: 0,
      totalTokensSaved: 0,
      efficiencyPercent: 0,
      durationMs: 0,
      status: "completed",
      tokenLabel: "estimated",
      output: "",
      finalCarryover: "",
    };

    let carryover = "";
    let previous = "";
    let done = false;
    try {
      while (!done && run.chunks.length < cfg.maxChunks) {
        if (options.abortSignal?.aborted) {
          run.status = "aborted";
          break;
        }
        const step = run.chunks.length + 1;
        const overlap = cfg.overlapTokens > 0 && previous ? previous.slice(-cfg.overlapTokens * 4) : "";
        const prompt = buildPrompt({ goal, step, carryover, overlap, memoryContext: options.memoryContext, mode });
        const { text } = await generator(prompt);
        const parsed = parseMarkers(text);
        run.chunks.push({ id: step, tokens: estimateTokens(parsed.cleaned), carryover, content: parsed.cleaned });
        previous = parsed.cleaned;
        const next = await nextCarryover({
          markerState: parsed.state,
          previous: carryover,
          chunkText: text,
          budget: cfg.carryoverTokens,
          compressorFn: this.opts.compressorFn,
        });
        carryover = next.carryover;
        if (parsed.done) done = true;
      }
      if (!done && run.status === "completed") run.status = "max-chunks";
    } catch (err) {
      run.status = "errored";
      run.error = (err as Error).message;
    }

    run.output = run.chunks.map((c) => c.content).join("\n\n");
    run.finalCarryover = carryover;
    const eff = runEfficiency(run.chunks, run.chunkConfig);
    run.totalTokensUsed = eff.totalTokensUsed;
    run.totalTokensSaved = eff.tokensSaved;
    run.efficiencyPercent = eff.efficiencyPercent;

    // Reflection pass: optional, and a failure never fails the run.
    if (options.reflect !== false && run.status === "completed" && run.chunks.length) {
      try {
        const { text } = await generator(
          `Reflect on this completed run.\nGoal: ${goal.slice(0, 200)}\nFinal state: ${carryover}\nVerdict: ratify or list concrete gaps.`,
          [],
          "You are the reflection pass. Be brief.",
        );
        run.reflection = cleanMarkers(text);
      } catch (err) {
        run.error = `reflection failed (run preserved): ${(err as Error).message}`;
      }
    }

    run.durationMs = this.clock() - start;
    this.history.push(run);
    if (this.historyFile) fs.writeFileSync(this.historyFile, JSON.stringify(this.history, null, 2));
    return run;
  }
}
