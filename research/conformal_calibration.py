#!/usr/bin/env python3
"""Conformal calibration of agent shadow outcomes (docs/AGENT_SETUP.md).

Reads the decision journal (SQLite, read-only), takes every graded shadow outcome
for the agent personas AND the ensemble, and produces split-conformal prediction
intervals for the signed post-horizon move (in %) at a chosen confidence level.

Method (finite-sample split-conformal, no model fitting):
  scores s_i = |y_i| (deviation of the realized signed move from zero)
  half-width q  = the ceil((n+1)*(1-alpha))/n empirical quantile of s_i
  interval      = [-q, +q] around 0, i.e. "this analyst's calls land within +/-q%"
This is the distribution-free conformal guarantee: a fresh outcome falls inside
the interval with probability >= level, ASSUMING exchangeability of the outcomes.

Honesty rules:
  - n below MIN_SAMPLE emits a warning and the width is marked unreliable.
  - flat outcomes (zero move) are kept: they are real observations.
  - the artifact records the journal window it was computed from.
  - this is a DESCRIPTION of past calibration, never a promotion input.

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

MIN_SAMPLE = 100  # below this, the conformal width is flagged unreliable
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
        if not isinstance(mark_at, (int, float)) or not isinstance(mark_at_expiry, (int, float)) or not mark_at:
            continue
        sign = 1.0 if direction == "long" else -1.0 if direction == "short" else 0.0
        move_pct = sign * (mark_at_expiry - mark_at) / mark_at * 100.0
        outcomes.append({
            "botId": bot_id,
            "time": time,
            "direction": direction,
            "grade": grade,
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
        "method": "split-conformal interval on the signed post-horizon move (score = |move|), no model fitting",
        "level": args.level,
        "minSample": MIN_SAMPLE,
        "note": "Description of past shadow calibration only. Never a promotion input: promotions come exclusively from the Lighter-capture research gate.",
        "personas": {},
        "pooled": summarize("pooled", outcomes, args.level),
    }
    for bot_id in sorted(by_bot):
        result["personas"][bot_id] = summarize(bot_id, by_bot[bot_id], args.level)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    summary = {name: (s["n"], s["hitRate"], s["intervalPct"]) for name, s in result["personas"].items()}
    print(f"calibration written: {out}")
    print(json.dumps(summary, indent=1))
    small = [name for name, s in result["personas"].items() if not s["reliable"]]
    if small:
        print(f"WARNING: n < {MIN_SAMPLE} for {', '.join(small)} - widths are not yet reliable", file=sys.stderr)


if __name__ == "__main__":
    main()
