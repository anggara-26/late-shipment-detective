// HTTP entry point: POST /run with {"question": "...", "filters"?: {...}}  (port 8000)
import http from "node:http";
import { investigate } from "./orchestrator.ts";

const port = Number(process.env.PORT ?? 8000);
http
  .createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body, null, 2));
    };
    if (req.method === "GET" && req.url === "/health") return send(200, { ok: true });
    if (req.method !== "POST" || req.url !== "/run") return send(404, { error: "POST /run" });
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return send(400, { error: "body must be JSON" });
    }
    if (!input?.question) return send(400, { error: 'body must include "question"' });
    try {
      send(200, await investigate(input));
    } catch (err) {
      send(500, { error: (err as Error).message });
    }
  })
  .listen(port, () => console.log(`Late Shipment Detective listening on http://localhost:${port}  (POST /run)`));
