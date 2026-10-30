# Agent layer — model API key setup (Gemini)

The agent layer runs AI agents as **proposal sources**: they never size orders,
never touch the executor, and their output enters the same journaled, capped,
executor-gated pipeline as strategy bots. A deterministic risk authority makes
every final call. Agents require an external model API key — Google Gemini from
AI Studio is the default choice because the operator already has Google
infrastructure and the free tier is enough for shadow mode.

## Obtaining the key (operator steps)

1. Open **https://aistudio.google.com** and sign in with a Google account.
2. Click **Get API key** → **Create API key** (choose or create a project when asked).
3. Copy the key. AI Studio now issues auth keys that start with `AQ.` (legacy
   keys started with `AIza`); both work — the runtime sends the GEMINI_API_KEY
   value as the API key header.
4. In AI Studio's billing/settings, set a **spend cap** (or stay on the free tier
   for shadow mode — free-tier rate limits are sufficient for scheduled agents).
5. Store it locally, never in chat, never in the repository:

```powershell
# From the project root — .env is already git-ignored
Set-Content -NoNewline -Path .env -Value "GEMINI_API_KEY=AIza...your-key..."
```

6. Verify the terminal sees it (the agent runtime reads `.env` on startup; the
   key is never logged, never written to the journal, never sent anywhere except
   Google's API over HTTPS).

## Key handling rules (non-negotiable)

- The key lives only in `.env` on this machine. Do not paste it into chat, commits,
  screenshots or the Word guide.
- Rotate it from AI Studio if it ever appears anywhere unexpected.
- The agent runtime enforces a daily request/ spend cap and stops proposing when
  the cap is hit — a missing or exhausted key degrades to no agents, never to
  bypassed risk checks.

## What the agents will be (build order)

1. **Agent sub-account — SHIPPED 2026-10-28.** The paper ledger accepts `agent-*`
   fills; `paperAnalytics().agents` attributes closed legs to the closing agent
   (fees to the filling agent) and `bots` again carries real per-actor rows.
   `Paper.agentOrder()` runs agent orders through the same executor behind a
   session-only `agentEnabled` latch (cleared and audited on restart) and an
   `agentAllocationPct` envelope fail-closed at 0%, bounded by agent-attributed
   open notional. Reductions are never latch-blocked. Decision journaling for
   agent proposals arrives with proposal contracts (step 2).
2. **Proposal contracts — SHIPPED 2026-10-30.** Typed, expiring direction opinions
   (src/agent-contract.ts): the runtime owns identity and timestamps (the model
   never claims an id, a symbol or a clock) and expiry is DERIVED from
   createdAt + horizonSeconds. Three personas (momentum / skeptic / flow) form
   the 2-of-3 ensemble (src/agent-ensemble.ts).
3. **Shadow mode — SHIPPED 2026-10-30.** The runtime (src/agent-runtime.ts,
   wired in src/server.ts) calls the models every 10 minutes for up to 2
   watched markets, journals every proposal/rejection/outcome into the decision
   journal (journal-as-agent-memory), ensembles 2-of-3, and grades each ensemble
   opinion at expiry against the real mark. NO ORDERS EVER: shadow mode is
   journal-only. Enable for this session: POST /api/agents/enable
   {"confirm":"ENABLE AGENT SHADOW"}; disable: POST /api/agents/disable;
   status: GET /api/agents; manual cycle: POST /api/agents/tick. Daily model
   request cap 500 (hard stop, journaled once); a missing key degrades to idle
   agents. Promotion to live paper execution remains an explicit future gate.
- **Dashboard — SHIPPED 2026-10-30.** The "AI agents" tab in the web UI shows
  the three personas' latest votes with confidence bars, their full rationale
  (the thought process), the ensemble quorum (2-of-3 dots) with any dissent or
  veto, the graded shadow-outcome ledger (correct vs wrong at expiry), and the
  complete thought-process timeline. Backed by GET /api/agents/activity
  (runtime status + the agent-memory journal). Enable/disable and a manual
  cycle sit right on the page. Read-only for the record plus the two session
  switches — nothing here executes orders.
4. **Risk reviewer** — an agent that reads the journal and flags risk-off
   conditions to the operator; it can only suggest, and the fixed risk check can
   still veto everything.
