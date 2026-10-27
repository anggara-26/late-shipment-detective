# Submission kit (for Anggara — not needed by judges)

## A. Demo video script (target 3:00, English narration)

**0:00–0:20 · Problem** (README header on screen)
"Our entry is for The Agent That Can Explain Why. An operations manager sees shipments arriving late and has to decide what to fix: carriers, suppliers, order priority. Blaming the wrong one is expensive. Late Shipment Detective finds the real cause, and tells you which suspects the data rules out."

**0:20–0:50 · Agents** (architecture diagram in README)
"Five agents. The Planner turns the question into hypotheses. The Retriever queries Zetaris. The Analyst states a claim. The Skeptic does not trust it: it runs its own queries through Zetaris, recounts every number, and can send the claim back or reject the suspect. The Planner re-plans after every verdict, and the Writer can only use verified evidence."

**0:50–1:50 · Live run** (terminal, font 18+)
`npm run investigate -- --input input_examples/example_1.json`
Point at, as they scroll by:
- Planner → Retriever: the hypotheses
- **Skeptic → Analyst `needs_revision`** (if it happens in your run): "the Analyst quoted the wrong number, the Skeptic recounted it in Zetaris and sent it back"
- **Skeptic → Planner `rejected`**: "ship mode was ruled out: only a few points between the best and worst mode"
- Planner `revise_plan` (drill-down if it adds one)
- the model id in brackets: "every call runs on NVIDIA Nemotron through Meterless Nightshift"

**1:50–2:25 · Sponsor tech**
- Show `logs/<trace>.jsonl` (one Retriever line with its SQL): "every query goes through Zetaris"
- Show `markovian.final_carryover` and `context_per_step` in the output JSON: "the whole investigation is one Markovian run. Between steps only this four-line state is carried forward, so the Planner's context stays flat while the full history keeps growing."
- Run `npm run test:markovian` → 8/8: "our engine passes the official Meterless conformance suite."

**2:25–3:00 · Output and impact**
Scroll the ANSWER: supported factor, ruled-out suspects, actions.
"Instead of switching carriers or dropping suppliers, the manager learns the real driver, here dispatch lag inside the warehouse, and which popular explanations the data doesn't support. That's a decision they can act on this week."

Recording: 1080p, hide `.env`, never show tokens. Name it `OAH2026-LateShipmentDetective-ExplainWhy-Demo.mp4`, and test the link in a private window.

## B. Slide deck (8 required points)

1. **Problem & users**: ops/procurement managers; late deliveries; costly wrong fixes (switching carriers or suppliers).
2. **Solution**: Late Shipment Detective, an evidence-backed "why" plus explicitly ruled-out suspects plus actions.
3. **Agent workflow**: the mermaid diagram from the README (screenshot it on mermaid.live); the Skeptic loop highlighted.
4. **Tech stack**: TypeScript/Node, Zetaris REST (Lightning SQL on TPC-H, loaded as Parquet filestore tables), Meterless Markovian engine, Meterless Nightshift, NVIDIA Nemotron, JSONL traces, sql.js sample mode.
5. **How Zetaris & Meterless were used**: Zetaris is the only data path (breakdowns + independent recounts). The investigation is one Markovian run with a carryover block. Nightshift handles every model call.
6. **What's unique**: the Skeptic verifies against Zetaris itself and its key output is a *rejection*. Markovian keeps the planner's context flat (show the context_per_step numbers). Conformance 8/8.
7. **Product visuals**: terminal run screenshot, trace snippet with `needs_revision` / `rejected`, final answer.
8. **Future**: register a company's real ERP/WMS tables in Zetaris; scheduled weekly monitoring; H-MEM to remember past investigations; a small web UI.

## C. Sponsor technology explanation (paste into the form)

Use README section 4 as-is. One-line version of "what was unique": *"Our Skeptic agent never trusts the Analyst: before any finding is approved it runs its own SQL through Zetaris to recount the numbers, and it rejects suspects the data doesn't support. The whole investigation runs as one Meterless Markovian run (our own implementation, 8/8 on the official conformance suite), so the Planner re-plans from a four-line carryover state instead of the growing history. Every model call goes through Meterless Nightshift to NVIDIA Nemotron, and the model is logged per step."*

## D. Pre-existing components (form)

"None. All code written during the build window. Open-source dependencies: sql.js, tsx, TypeScript, DuckDB (TPC-H generation in `npm run load-tpch`). The Meterless Markovian conformance runner (Apache-2.0) is vendored unchanged as a test."

## E. Before submitting

- [ ] `npm run check` shows Zetaris ✔ and Nightshift online with a Nemotron model
- [ ] Re-run `npm run examples` in **live** mode (SAMPLE_MODE=false) so output_examples show real Zetaris + Nemotron runs
- [ ] `git log` has no `.env`; the repo is **public**; the README video link is filled in
- [ ] Team on HackOS correct before creating the submission; track = The Agent That Can Explain Why
