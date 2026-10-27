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
3. Copy the key (starts with `AIza...`).
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

1. **Agent sub-account** — a dedicated paper accounting slice with its own
   capital allocation, baseline and journal, so agent P&L is measured separately
   from manual trading and strategy bots.
2. **Proposal contracts** — typed proposals with market, direction, horizon,
   confidence, rationale and an expiry timestamp; stale proposals auto-reject.
   Ensemble rule: 2-of-3 agent agreement before the risk check sees a proposal.
3. **Shadow mode** — agents propose for N days; the decision journal records what
   would have happened; promotion to live paper execution is an explicit gate.
4. **Risk reviewer** — an agent that reads the journal and flags risk-off
   conditions to the operator; it can only suggest, and the fixed risk check can
   still veto everything.
