# Live-readiness gate — currently NOT satisfied

Nothing in this checklist is an authorization to trade. There is intentionally no live-mode switch.

## Broker/data
- Confirm jurisdiction, account eligibility, instrument permissions, capital and subscriptions.
- Pin/test adapter and dependencies, broker-native stops and cancel/OCA behavior.
- Point-in-time datasets with provenance, quality checks, trading calendars and contract-roll rules.
- Crypto venue, custody, least-privilege keys without withdrawal rights, precision/minimums and maintenance policy. Funding, mark/index pricing and liquidation required before perpetuals.

## Risk/execution
- Account-wide loss, drawdown, margin, notional and order-frequency limits.
- Concurrent exposure reservation and explicit manual-trade handling.
- Stable client IDs; unknown submissions reconciled before retry.
- Partial fills, cancel/fill races, stale quotes, clock drift, rate limits and rejected protection.
- Durable independent halt authority and alternate operational access.
- Flatten workflow distinguishes requested, acknowledged, confirmed, failed and unknown.
- Recovery cannot resume until broker/account reconciliation completes.

## Research/learning
- Leakage controls, untouched tests, walk-forward evaluation, multiple-testing records.
- Realistic commissions, spread, liquidity, latency and fill assumptions.
- Point-in-time text ingestion; assess model pretraining contamination for historical studies.
- Paper/shadow evidence and explicit limited-capital promotion approval.
- Challenger changes are versioned; no silent online code editing or autonomous leverage increase.

## Operations/security
- Authentication, authorization and TLS before remote access.
- Credentials isolated, secrets redacted and dependencies reviewed.
- Resource isolation between execution and research.
- Monitoring and alert delivery tested independently of UI.
- Backup restore, power loss, disconnect, restart and failed-flatten drills.
- Written incident runbooks and operator approval.

## Current test scope
Automated research, persistence and HTTP tests are included. Broker conformance, exchange fills, browser visual regression, failover and live-market acceptance are not claimed. Synthetic data is for UI/research plumbing only, never evidence of profitability.