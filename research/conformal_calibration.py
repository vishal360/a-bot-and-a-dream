#!/usr/bin/env python3
"""Conformal calibration of agent shadow outcomes (docs/AGENT_SETUP.md).

Reads the decision journal (SQLite, read-only), takes every graded shadow outcome
for the agent personas AND the ensemble, and produces:

1. Split-conformal prediction intervals for the signed post-horizon move (in %)
   at a chosen confidence level — a description of the RETURN distribution.
2. Probability-claim diagnostics for the confidence number itself (review P0-09):
   Brier score and reliability bins of "claimed confidence" vs observed correctness.

Method (finite-sample split-conformal, no model fitting):
  scores s_i = |y_i| (deviation of the realized signed move from zero)
  half-width q  = the ceil((n+1)*(1-alpha))/n empirical quantile of s_i
  interval      = [-q, +q] around 0, i.e. "this analyst's calls land within +/-q%"
This is the distribution-free conformal guarantee: a fresh outcome falls inside
the interval with probability >= level, ASSUMING exchangeability of the outcomes.

Honesty rules (sharpened by the 2026-11-07 external review):
  - The conformal interval describes the RETURN distribution. It does NOT make the
    analyst's claimed "70% confidence" a calibrated probability. That claim is
    diagnosed separately by the Brier score and reliability bins.
  - n below MIN_SAMPLE emits a warning; the interval is marked unstable and the
    Brier/reliability numbers are descriptive only.
  - Flat outcomes (zero move) are kept: they are real observations.
  - This is a DESCRIPTION of past shadow behavior, never a promotion input.

Usage:
  research/.venv/Scripts/python.exe research/conformal_calibration.py \
      [--db data/terminal.sqlite] [--out research/calibration.json] [--level 0.90]
"""
import argparse
import json
import math
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

MIN_SAMPLE = 100  # below this, widths and probability diagnostics are flagged unreliable
ROOT = Path(__file__).resolve().parent.parent


def load_outcomes(db_path: Path):
    if not db_path.exists():
        raise SystemExit(f"database not found: {db_path}")
    conn = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True)
    try:
        rows = conn.execute(
            "SELECT bot_id, time, inputs FROM decision_journal "
            "WHERE decision='agent-outcome' AND bot_id LIKE 'agent-%'"
        ).fetchall()
    finally:
        conn.close()
    outcomes = []
    for bot_id, time, inputs_json in rows:
        try:
            inputs = json.loads(inputs_json or "{}")
        except json.JSONDecodeError:
            continue
        mark_at, mark_at_expiry = inputs.get("markAt"), inputs.get("markAtExpiry")
        direction, grade = inputs.get("direction"), inputs.get("grade")
        confidence = inputs.get("confidence")
        if not isinstance(mark_at, (int, float)) or not isinstance(mark_at_expiry, (int, float)) or not mark_at:
            continue
        sign = 1.0 if direction == "long" else -1.0 if direction == "short" else 0.0
        move_pct = sign * (mark_at_expiry - mark_at) / mark_at * 100.0
        outcomes.append({
            "botId": bot_id,
            "time": time,
            "direction": direction,
            "grade": grade,
            "confidence": confidence if isinstance(confidence, (int, float)) else None,
            "movePct": move_pct,
        })
    return outcomes


def conformal_interval(moves, level):
    """Finite-sample split-conformal interval around 0 for the signed moves."""
    n = len(moves)
    if n == 0:
        return None
    scores = sorted(abs(m) for m in moves)
    rank = min(n, math.ceil((n + 1) * level))
    q = scores[rank - 1]
    return q


def reliability_bins(rows, bins=5):
    """Claimed-confidence deciles vs observed correctness: does '70% confident' mean
    70% of those calls were correct? Returns per-bin claimed mean, observed rate, n."""
    usable = [r for r in rows if isinstance(r.get("confidence"), (int, float))]
    out = []
    per = 1.0 / bins
    for b in range(bins):
        lo, hi = b * per, (b + 1) * per
        group = [r for r in usable if lo <= r["confidence"] < hi or (b == bins - 1 and lo <= r["confidence"] <= hi)]
        if not group:
            continue
        claimed = sum(r["confidence"] for r in group) / len(group)
        observed = sum(1 for r in group if r["grade"] == "correct") / len(group)
        out.append({"bin": f"{lo:.1f}-{hi:.1f}", "n": len(group),
                    "claimedMean": round(claimed, 4), "observedCorrectRate": round(observed, 4)})
    return out


def brier(rows):
    """Brier score of the confidence-as-probability-of-correct claim (0 = perfect,
    0.25 = always-50% guess, 1 = perfectly wrong). Descriptive below MIN_SAMPLE."""
    usable = [r for r in rows if isinstance(r.get("confidence"), (int, float))]
    if not usable:
        return None
    total = sum((r["confidence"]) ** 2 + (1 - r["confidence"]) ** 2 for r in usable
                if r["grade"] == "correct") + \
            sum((r["confidence"]) ** 2 + (1 - r["confidence"]) ** 2 for r in usable
                if r["grade"] != "correct")
    # For a binary outcome y in {0,1} and claimed probability p of y=1:
    # y=1 -> (1-p)^2 contribution; y=0 -> p^2 contribution.
    total = 0.0
    for r in usable:
        y = 1.0 if r["grade"] == "correct" else 0.0
        p = r["confidence"]
        total += (p - y) ** 2
    return round(total / len(usable), 4) if usable else None


def summarize(name, rows, level):
    n = len(rows)
    moves = [r["movePct"] for r in rows]
    correct = sum(1 for r in rows if r["grade"] == "correct")
    q = conformal_interval(moves, level) if n else None
    inside = sum(1 for m in moves if q is not None and abs(m) <= q) if n else 0
    return {
        "botId": name,
        "n": n,
        "hitRate": round(correct / n, 4) if n else None,
        "directions": {
            "long": sum(1 for r in rows if r["direction"] == "long"),
            "short": sum(1 for r in rows if r["direction"] == "short"),
        },
        "absMoveQuantilePct": round(q, 4) if q is not None else None,
        "intervalPct": [-q, q] if q is not None else None,
        "empiricalCoverage": round(inside / n, 4) if n else None,
        "brierScoreOfConfidenceClaim": brier(rows),
        "reliabilityBins": reliability_bins(rows),
        "reliable": n >= MIN_SAMPLE,
        "window": {
            "first": min((r["time"] for r in rows), default=None),
            "last": max((r["time"] for r in rows), default=None),
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=str(ROOT / "data" / "terminal.sqlite"))
    parser.add_argument("--out", default=str(ROOT / "research" / "calibration.json"))
    parser.add_argument("--level", type=float, default=0.90)
    args = parser.parse_args()
    if not 0.5 <= args.level < 1.0:
        raise SystemExit("--level must be in [0.5, 1.0)")

    outcomes = load_outcomes(Path(args.db))
    by_bot = {}
    for row in outcomes:
        by_bot.setdefault(row["botId"], []).append(row)

    result = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "method": "split-conformal interval on the signed post-horizon move (score = |move|), no model fitting; Brier + reliability bins for the confidence CLAIM",
        "level": args.level,
        "minSample": MIN_SAMPLE,
        "note": "Description of past shadow behavior only, never a promotion input. The conformal interval describes the RETURN distribution; it does not make the claimed confidence a calibrated probability — see brierScoreOfConfidenceClaim and reliabilityBins.",
        "personas": {},
        "pooled": summarize("pooled", outcomes, args.level),
    }
    for bot_id in sorted(by_bot):
        result["personas"][bot_id] = summarize(bot_id, by_bot[bot_id], args.level)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    summary = {name: (s["n"], s["hitRate"], s["intervalPct"], s["brierScoreOfConfidenceClaim"]) for name, s in result["personas"].items()}
    print(f"calibration written: {out}")
    print(json.dumps(summary, indent=1))
    small = [name for name, s in result["personas"].items() if not s["reliable"]]
    if small:
        print(f"WARNING: n < {MIN_SAMPLE} for {', '.join(small)} - widths and probability diagnostics are descriptive only", file=sys.stderr)


if __name__ == "__main__":
    main()
