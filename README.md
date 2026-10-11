# RoutePilot

A constraint-led executive travel decision workspace that shows its reasoning.

**Status: Checkpoint A complete.** Deterministic decision engine, nine seeded scenarios, structured
manual entry, and the test suite. Not deployed. No GitHub remote. No AI, no voice, no paste parsing
— those are Checkpoints B–D.

---

## The architectural decision this project exists to demonstrate

**The LLM never computes. The LLM never ranks.**

| Responsibility | Owner |
|---|---|
| Eliminating infeasible options, computing every measure, applying the priority rule, selecting the fallback, emitting the trace | **Deterministic TypeScript** (`lib/decision/`) — pure, no I/O, no randomness, no clock access |
| Parsing natural language into a typed constraint patch, asking clarifying questions, narrating a trace it may not add to | A model — **Checkpoint B onward, optional, off by default** |

If a model produced the ranking, the "decision record" would be theatre. That split is the whole
point: the engine is a pure function, so the same input always yields the same trace, and a trace
worth auditing is one that can be reproduced.

In Checkpoint A there is **no model involvement at all.** The brief is deterministic templated prose
generated from the trace, which is why it cannot introduce a reason the engine did not compute.

---

## What this is not

- **Not a booking tool.** No inventory, no payment, no reservations. It ends where booking begins.
- **Not a market search.** It compares the options you give it. It does not go looking for options.
- **Not a live data source.** Nothing is fetched. `LIVE_VERIFIED` exists in the provenance type and
  is deliberately unreachable — a test asserts no code path can produce it.
- **Not a punctuality predictor.** The engine inspects itinerary characteristics — buffer sizes,
  connection counts, overnight legs. It holds no historical on-time performance data and therefore
  cannot estimate any probability of arriving on time. A test fails the build if the words
  "on-time", "punctual", "probability" or "reliability" appear in user-facing copy about a priority
  rule.

---

## The decision model

**Stage 1 — Feasibility gate.** Firm constraints eliminate. An option that misses a hard arrival
deadline is not "expensive", it is out: eliminated options are removed from the ranked set entirely,
so a violator cannot rank first by construction rather than by tuning a penalty large enough to
dominate.

**Stage 2 — Separate measures.** Cash payable, points required, taxes and fees, arrival margin,
connection findings, travel duration — each computed and displayed independently. **There is no
blended score.**

Two cash figures are kept deliberately separate and are never summed:

| Field | Meaning |
|---|---|
| `comparableCashTicketTotal` | Full all-in price of buying the equivalent ticket for cash. On an award option this is the *baseline* — the cash avoided — not money you hand over. |
| `awardCashCoPayment` | Cash still payable alongside a redemption. On an award option, this **is** what you pay. |

**Stage 3 — Effective cents-per-point** *(optional module)*:

```
(comparableCashTicketTotal − awardCashCoPayment) ÷ pointsRequired
```

Computed only when the cash and award itineraries are genuinely comparable — same origin and
destination, same dates, same cabin, and a cash counterpart that exists. If any check fails it
reports **"cannot be reliably calculated"** and names the failed check, rather than showing a number
with a caveat.

**Stage 4 — Ranking by an explicit priority rule.** Four named rules, each a fixed comparator
sequence with explicit sort directions. No weights, no cross-unit conversion, no invented exchange
rate between time and money:

| Rule | Comparator sequence |
|---|---|
| `arrival_buffer_first` *(default)* | arrival margin **DESC** → finding count **ASC** → cash payable **ASC** |
| `fewest_connection_risks` | finding count **ASC** → arrival margin **DESC** → cash payable **ASC** |
| `lowest_cash_outlay` | cash payable **ASC** → arrival margin **DESC** → finding count **ASC** |
| `shortest_travel_time` | travel duration **ASC** → cash payable **ASC** → finding count **ASC** |

Lexicographic ordering makes explanation trivial: "A beat C because arrival margin was 240 against
150" is read straight off the deciding comparator rather than reconstructed from weight
contributions.

### Time handling

Every instant is an ISO 8601 timestamp **with an explicit offset**, alongside an **IANA timezone
id**. The offset makes instant comparison exact; the zone id is still needed to resolve "noon in New
York" across a DST transition and to ask wall-clock questions like "is this layover in the local
small hours". Local clock times are never compared. An option lacking a resolvable date or zone is
flagged for confirmation and **excluded from ranking** — never guessed.

This is the likeliest silent correctness bug in the whole engine, which is why it has its own test
suite covering cross-midnight itineraries, destination-zone deadlines and both sides of a DST
transition.

---

## Running it

```bash
npm install
npm run dev        # http://localhost:3000
```

```bash
npm test           # full suite
npm run test:nokey # the suite with all credentials cleared in-process
npm run typecheck
npm run build
```

Every command works identically in PowerShell, cmd, Git Bash and CI. `test:nokey` deliberately
avoids the POSIX-only `VAR= npm test` form, which is a parse error in PowerShell — it clears the
variables from a Vitest setup file instead.

That setup file clears **both** `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` (plus
`ANTHROPIC_PROFILE`), because an unset API key does not mean "no credentials": the SDK resolves a
chain, and a no-key test that clears only the first variable can pass by making real, billed calls.

---

## Capability matrix

What is available in which mode. **No capability is presented as working when its mode is off.**

| Capability | Public demo (`AI_FEATURES_ENABLED=false`) | Local dev / passphrase demo |
|---|---|---|
| Nine seeded scenarios | ✅ | ✅ |
| Structured manual option entry | ✅ | ✅ |
| Feasibility gate, four priority rules, trace | ✅ | ✅ |
| Recommendation, risks, fallback | ✅ | ✅ |
| Executive brief + print | ✅ | ✅ |
| Rewards module (optional) | ✅ | ✅ |
| Constraint ledger editing | ✅ | ✅ |
| Deterministic paste parsing | ⏳ Checkpoint C | ⏳ Checkpoint C |
| Voice-to-text → transcript | ⏳ Checkpoint B | ⏳ Checkpoint B |
| Transcript → constraints (AI) | ❌ requires key | ⏳ Checkpoint B |
| Arbitrary paste parsing (AI) | ❌ requires key | ⏳ Checkpoint C |

**Everything shipped in Checkpoint A runs with no API key and no network.**

---

## Data flow

Three categories. The boundary is **which operation you invoke**, not whether you typed or spoke.

**Category 1 — on-device only, no network transmission of trip data.** Everything in Checkpoint A:
scenario selection, manual entry, constraint edits, the feasibility gate, all four priority rules,
the trace, the recommendation, the brief, and `localStorage` persistence.

Verified empirically: loading a scenario, switching the priority rule and generating a brief produce
**zero `/api/*` requests and zero POSTs** — only static asset GETs.

**Category 2 — Checkpoint B onward, explicit action after disclosure.** Natural-language text you
submit for interpretation goes to this app's backend and then to the model provider. The payload is
the redacted text plus constraint *keys and kinds* only. Never the profile, never the trip state,
never the options, measures, ranking or trace.

**Category 3 — Checkpoint B onward, separate disclosure.** Browser speech recognition sends **raw
audio** to the browser's recognition service (in Chrome, Google's). It does not pass through this
app's backend and cannot be restricted by it. This is the *least* local part of the eventual design,
which is why it gets its own disclosure rather than being bundled with the AI one.

`localStorage` is **browser-local persistence, not encrypted secure storage.** Do not enter
sensitive information on a shared or public device. Prefer synthetic data; the app deliberately has
no field for a passport number, a loyalty credential or a payment detail.

---

## Model configuration (Checkpoint B onward — nothing below is used yet)

**Verify the model is available to your own account before setting it.** Do not trust a model id
from documentation or from an assistant's memory:

```bash
curl https://api.anthropic.com/v1/models \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01"
```

PowerShell — use `curl.exe`, not PowerShell's `curl` alias for `Invoke-WebRequest`:

```
curl.exe https://api.anthropic.com/v1/models -H "x-api-key: $env:ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01"
```

Recommended model: **`claude-opus-5-5`**. Configured once via `ANTHROPIC_MODEL`; a test asserts no
API route hardcodes a `claude-` string, so changing tier stays a one-line env change.

**A Claude Code or Claude Pro subscription provides no runtime API credits to a deployed
application.** That needs a separate Anthropic Console account with its own billing and its own key.

Both planned AI operations will use **structured outputs** (`output_config.format`), not forced tool
calling — `tool_choice: {type:"any"}` returns a 400 on the current Opus and Sonnet models.

Measured per-interaction costs will be recorded here before anything is deployed with AI enabled.
Until then, treat the public demo default as `AI_FEATURES_ENABLED=false`, which eliminates the
credit-drain risk rather than mitigating it.

---

## Project layout

```
lib/schema/      Zod schemas — validate SHAPE
lib/decision/    the engine — pure, isomorphic, imported directly by the UI
lib/brief/       deterministic brief rendering
lib/sources/     FareSource interface ONLY — no implementation, no paid API
lib/data/        nine scenarios + the ranking-discrimination and tie-breaker fixtures
app/             the workspace UI (client components, no API routes)
tests/           Vitest
```

**Schema validates shape; the engine validates sufficiency.** A missing cash figure is not a schema
error — it is the normal state of a half-entered option, and the product's job is to ask for it. The
engine reports it as a `missing_required` need. Rejecting it in the schema would have made the
engine's entire missing-data branch unreachable, so the check would have looked rigorous while
testing nothing.

---

## Hypotheses — all unvalidated

No user research has been conducted. These are stated as untested bets, not findings:

1. An auditable decision record produces faster approval and fewer clarifying round-trips than a
   conversational recommendation, with identical option data.
2. Assistants will correct a structured constraint ledger more readily than they will restate a
   whole request.
3. **Riskiest:** executives value "why not the cheaper option" as an explicit artifact.
4. An explicit user-chosen priority rule is more trusted than a single optimised score.
5. Points-versus-cash matters for assistant-booked *business* travel — it may be largely a
   personal-travel behaviour, which is why it is an optional module and not half the product.

Nothing here may be described as validated until real interview responses are collected and
documented.
