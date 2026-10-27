// Meterless Nightshift client: the app's primary AI provider.
// OpenAI-compatible Runtime at METERLESS_BASE_URL (default http://127.0.0.1:8088/v1).
// Every request sends Authorization, meterless-app and meterless-scope headers,
// and we record the concrete model Nightshift routed to (e.g. a Nemotron id).
import { config } from "../config.ts";

export interface ChatResult {
  content: string;
  model: string;
}

export class NightshiftError extends Error {}

function headers(): Record<string, string> {
  if (!config.meterless.token || config.meterless.token === "rt-local") {
    throw new NightshiftError("METERLESS_RUNTIME_TOKEN is not set (copy it from Nightshift → Console).");
  }
  return {
    Authorization: `Bearer ${config.meterless.token}`,
    "meterless-app": config.meterless.app,
    "Content-Type": "application/json",
  };
}

/** Connection status per the Meterless provider contract: online | unauthorized | offline. */
export async function nightshiftStatus(): Promise<{ status: "online" | "unauthorized" | "offline"; models: string[]; detail?: string }> {
  try {
    const res = await fetch(`${config.meterless.baseUrl}/models`, { headers: headers(), signal: AbortSignal.timeout(10_000) });
    if (res.status === 401 || res.status === 403) return { status: "unauthorized", models: [] };
    if (!res.ok) return { status: "offline", models: [], detail: `HTTP ${res.status}` };
    const body = (await res.json()) as { data?: { id: string }[] };
    return { status: "online", models: (body.data ?? []).map((m) => m.id) };
  } catch (err) {
    return { status: "offline", models: [], detail: (err as Error).message };
  }
}

export async function chat(messages: { role: "system" | "user" | "assistant"; content: string }[], opts: { deep?: boolean; temperature?: number } = {}): Promise<ChatResult> {
  const model = opts.deep && config.meterless.deepModel ? config.meterless.deepModel : config.meterless.model;
  const res = await fetch(`${config.meterless.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { ...headers(), "meterless-scope": "user" },
    body: JSON.stringify({ model, messages, temperature: opts.temperature ?? 0.2 }),
    signal: AbortSignal.timeout(config.meterless.timeoutMs),
  });
  if (res.status === 401 || res.status === 403) throw new NightshiftError("Nightshift rejected the Runtime token (unauthorized).");
  if (!res.ok) throw new NightshiftError(`Nightshift HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { model?: string; choices?: { message?: { content?: string } }[] };
  const raw = body.choices?.[0]?.message?.content ?? "";
  // Reasoning models may wrap thoughts in <think> tags; keep only the answer.
  const content = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return { content, model: body.model ?? model };
}

/** Extract the first JSON object from a model reply. */
export function parseJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fenced ? fenced[1] : text;
  const start = src.indexOf("{");
  const end = src.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model reply");
  return JSON.parse(src.slice(start, end + 1)) as T;
}
