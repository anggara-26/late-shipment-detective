// CLI entry point: npm run investigate -- --input input_examples/example_1.json
//              or: npm run investigate -- "Why are deliveries from ASIA late?"
import fs from "node:fs";
import path from "node:path";
import { investigate } from "./orchestrator.ts";

const args = process.argv.slice(2);
const i = args.indexOf("--input");
const out = args.indexOf("--out");
let input;
if (i >= 0) input = JSON.parse(fs.readFileSync(args[i + 1], "utf-8"));
else if (args.length && !args[0].startsWith("--")) input = { question: args.join(" ") };
else {
  console.error('Usage: npm run investigate -- --input input_examples/example_1.json [--out file.json]\n   or: npm run investigate -- "Why are shipments from ASIA late?"');
  process.exit(1);
}

try {
  const result = await investigate(input);
  console.log("\n================ ANSWER ================\n");
  console.log(result.answer.report_markdown);
  console.log(`\nmodels: ${result.models_used.join(", ")} · send-backs: ${result.collaboration.skeptic_send_backs} · ruled out: ${result.collaboration.skeptic_rejections} · Markovian chunks: ${result.markovian.chunks}`);
  const last = result.markovian.context_per_step.at(-1);
  if (last) console.log(`Planner context at last step: ${last.planner_context_tokens} tokens (carryover only) vs ${last.naive_history_tokens} if it re-read the full history`);
  console.log(`trace: ${result.log_path}`);
  if (out >= 0) {
    fs.mkdirSync(path.dirname(args[out + 1]), { recursive: true });
    fs.writeFileSync(args[out + 1], JSON.stringify(result, null, 2) + "\n");
    console.log(`saved: ${args[out + 1]}`);
  }
} catch (err) {
  console.error(`\n✖ ${(err as Error).message}`);
  process.exit(1);
}
