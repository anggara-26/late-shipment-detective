// npm run examples — runs every input in input_examples/ and saves the REAL
// outputs to output_examples/. Outputs are never read back at runtime.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.ts";
import { investigate } from "../src/orchestrator.ts";

const dir = path.join(ROOT, "input_examples");
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
  const input = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
  const result = await investigate(input);
  const out = path.join(ROOT, "output_examples", f.replace(".json", "_output.json"));
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  console.log(`\nsaved ${path.relative(ROOT, out)}\n`);
}
