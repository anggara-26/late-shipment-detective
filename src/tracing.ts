// JSONL traces: every agent action and hand-off is written to logs/<trace_id>.jsonl
// and echoed to stdout, so judges can follow the collaboration step by step.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.ts";

export interface TraceEvent {
  agent_name: string;
  action: string;
  input_summary: string;
  output_summary: string;
  target_agent: string;
  status: "success" | "needs_revision" | "rejected" | "retrying" | "fallback" | "partial_success" | "error";
  model?: string;
  confidence?: number;
  retry_count?: number;
  sql?: string;
  duration_ms?: number;
}

export class Tracer {
  readonly traceId: string;
  readonly file: string;
  readonly events: (TraceEvent & { timestamp: string; trace_id: string })[] = [];
  private quiet: boolean;

  constructor(opts: { quiet?: boolean } = {}) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
    this.traceId = `run_${stamp}_${Math.random().toString(36).slice(2, 6)}`;
    const dir = path.join(ROOT, "logs");
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${this.traceId}.jsonl`);
    this.quiet = opts.quiet ?? false;
  }

  log(e: TraceEvent): void {
    const rec = { timestamp: new Date().toISOString(), trace_id: this.traceId, retry_count: 0, ...e };
    this.events.push(rec);
    fs.appendFileSync(this.file, JSON.stringify(rec) + "\n");
    if (!this.quiet) {
      const model = rec.model ? ` [${rec.model}]` : "";
      console.log(`  ${rec.agent_name.padEnd(16)} → ${rec.target_agent.padEnd(16)} ${rec.status.padEnd(15)} ${rec.output_summary}${model}`);
    }
  }
}
