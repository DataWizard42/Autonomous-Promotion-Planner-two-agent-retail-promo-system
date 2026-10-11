# Autonomous Promotion Planner

**ET AI Hackathon: Agentic Edition — Problem 3 (Retail)**

A two-agent system that plans retail promotions end-to-end and lets a human inject plain-language business constraints that a second agent acts on.

---

## Quick start

```
open index.html   # or drag into any browser — no server, no build step
```

That's it. The planning agent runs entirely in the browser. Agent 2 (business-constraints) works in offline/demo mode without an API key.

---

## Architecture

```
Inventory / prices / margins / segments
Season multiplier, competitor prices
         │
         ▼
 ┌─────────────────────────────────┐
 │  Agent 1 — Planning Engine      │  (deterministic, runs client-side)
 │  1. score discount × duration   │
 │  2. margin floor + cannib + halo│
 │  3. greedy fill + repair pass   │
 │  4. mechanism + audience rules  │
 │  5. regional discount deltas    │
 │  6. Monte Carlo (300 iters)     │
 └────────────────┬────────────────┘
                  │  proposed plan (JSON)
                  ▼
 ┌─────────────────────────────────┐
 │  Agent 2 — Business-Constraints │  (LLM, non-deterministic)
 │  reads plan + stakeholder note  │
 │  decides KEEP / ADJUST / VETO   │
 │  per product, with stated reason│
 └────────────────┬────────────────┘
                  │
                  ▼
        Final plan + full agent trace
```

---

## File structure

| File | Purpose |
|------|---------|
| `index.html` | Page markup — all 6 interaction steps |
| `styles.css` | Design tokens, light/dark mode, component styles |
| `app.js` | Planning engine, Monte Carlo, LLM agent, UI handlers |
| `README.md` | This file |

---

## Agent 1 — Planning Agent (heuristic engine)

**Inputs per product:** price, cost, stock, daily sell-through, price elasticity, competitor price, substitute group, complement pairing.

**Core steps:**

1. **Candidate scoring** — try all (discount depth × duration) pairs (5–40% × 3/7/14 days). Reject any breaching the margin floor.
2. **Demand model** — constant-elasticity curve adjusted by a competitiveness factor (discounted price vs. competitor's price).
3. **Cannibalization & halo** — subtract cannibalization profit (18% of uplift from same substitute group); add halo profit (8% of complement's daily baseline × duration).
4. **Clearance bonus** — 25% score boost when stock cover ≥ 45 days.
5. **Budget fill** — rank candidates by net profit / rupee spent; greedy fill; repair (step down discount) rather than drop when product doesn't fit.
6. **Mechanism & audience** — rule-based assignment (clearance / bundle / price-match / tiered / flash-sale; deal-seekers / loyal-members / new-and-lapsed).
7. **Regional deltas** — per-region competitive-intensity multiplier shifts the discount depth up or down.
8. **Monte Carlo** — 300 iterations with demand ±15% and elasticity ±10%; reports P10/P50/P90 profit and margin/budget pass rates.

**No LLM needed.** Closed-form math + greedy fill → cheap to re-run on every market tick.

---

## Agent 2 — Business-Constraints Agent (LLM)

**Why it exists:** rules can't anticipate legal recalls, brand directives, or competitor rumors. This agent reads the optimized plan and a free-text stakeholder note and decides, per product, whether to KEEP, ADJUST, or VETO.

**Prompt shape:**

```
You are a business-constraints review agent for a retail promotion plan.
Proposed plan (JSON): [...]
Business context from a stakeholder: "<free text>"

Decide, per product in the plan, whether to KEEP, ADJUST (lower the discount,
say to what %) or VETO (cancel) the promotion based on this context.

Respond ONLY with JSON:
{"decisions":[{"product":"","action":"keep|adjust|veto","new_discount_pct":null,"reason":""}],"summary":""}
No markdown, no prose outside the JSON.
```

**Output:** machine-actionable JSON (drives table row highlighting/strikethrough) with a `reason` field that keeps decisions explainable to judges and stakeholders.

**Offline fallback:** `buildMockLLMResponse()` in `app.js` applies keyword rules so the demo works without any API access.

**Model guidance:** for a production build, use a mid-tier Claude Sonnet model via the Anthropic Messages API at `temperature ≈ 0` for consistent, auditable decisions. Confirm the exact current model string in the [Anthropic API docs](https://docs.anthropic.com) before hardcoding — model names change.

---

## Data catalogue (synthetic)

8 SKUs across TV, audio, laptops, cameras, tablets, and e-readers. Each has:
- Price, cost, stock, daily sell-through
- Price elasticity (from −0.9 to −1.8)
- Competitor price
- Substitute group (cannibalization domain)
- Complement pairing (halo source)

**Hardest inputs to get right in production:** elasticity and cannibalization — these need to be fitted from historical promotion data, not guessed.

---

## Design tokens

| Token | Value | Use |
|-------|-------|-----|
| `--bg` | `#f2f4f7` | Page background |
| `--card` | `#ffffff` | Card surface |
| `--ink` | `#14213d` | Primary text |
| `--muted` | `#5c667a` | Secondary text |
| `--line` | `#d9dee7` | Borders |
| `--accent` | `#ffc300` | Active discount tag |
| `--bad` | `#c1121f` | Veto / over-budget |
| `--ok` | `#0f8b6f` | Keep / healthy margin |

Dark mode via `prefers-color-scheme: dark`. Font: **Bricolage Grotesque** (400/600/800).

---

## Scope declaration

This is a **prototype** built for a hackathon demo. The following are explicitly out of scope and noted as "what's next":

- Real elasticity/cannibalization fitted from historical data
- Schema validation + confidence flags on LLM output
- Human-approval step before a veto actually blocks a promotion
- Persistent audit log for both agents' decisions
- Server-side LLM call (never expose API keys in client JS in production)
- Authentication
- Automated tests for margin-floor and budget guarantee constraints

---

## Run instructions

1. Download / clone all four files into the same folder.
2. Open `index.html` in any modern browser.
3. Optionally inject the Anthropic JS SDK and your API key before `<script src="app.js">` to enable live LLM calls (see `app.js` → `runConstraintsAgent`).
4. Without an API key, Agent 2 runs in demo/mock mode automatically.
