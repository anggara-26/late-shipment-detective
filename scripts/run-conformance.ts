// Runs the official Meterless Markovian conformance suite against this
// project's own engine implementation (src/engines/markovian/index.ts).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const impl = path.join(root, "src", "engines", "markovian", "index.ts").split(path.sep).join("/");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const r = spawnSync(process.execPath, [tsxCli, path.join(root, "tests", "conformance", "runner.ts")], {
  stdio: "inherit",
  env: { ...process.env, MARKOVIAN_IMPL: impl },
});
process.exit(r.status ?? 1);
