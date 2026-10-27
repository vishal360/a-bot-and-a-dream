"""spa_verify.py - multiple-testing correction for strategy replay results.

This is the research lane's promotion gate. The terminal's replay backtester can
score any number of configurations over a recorded capture; the best of N looks
good by construction. Hansen's SPA and Romano-Wolf StepM (via Kevin Sheppard's
`arch` package) answer the only question that matters before a configuration may
be promoted to a registered strategy artifact: does ANY configuration beat the
benchmark (holding cash) after correcting for the N attempts?

Input  (JSON): {"source": "...", "configs": [{"id": "...", "equity": [..]}, ...]}
               Equity curves from replay runs over the SAME capture, equal spacing.
Output (JSON): {"spa_pvalue": float, "stepm_survivors": [...], "verdict": "PASS"|"FAIL",
                "samples": int, "configs": int, "reps": int, "reasons": [...], "generatedAt": "..."}

Fail-closed: fewer than 2 configs, mismatched lengths, or fewer than MIN_SAMPLES
observations produce verdict FAIL with reasons - never a silent pass.
"""

import argparse
import json
import sys
from datetime import datetime, timezone

MIN_SAMPLES = 100
MIN_CONFIGS = 2


def fail(reasons, output):
    json.dump({"verdict": "FAIL", "spa_pvalue": None, "stepm_survivors": [],
               "samples": 0, "configs": 0, "reps": 0, "reasons": reasons,
               "generatedAt": datetime.now(timezone.utc).isoformat()}, open(output, "w"), indent=1)
    print(json.dumps({"verdict": "FAIL", "reasons": reasons}))
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--input", help="JSON file with configs[].equity arrays")
    parser.add_argument("--output", help="Where to write the verdict JSON")
    parser.add_argument("--reps", type=int, default=2000, help="Stationary bootstrap repetitions")
    parser.add_argument("--alpha", type=float, default=0.05, help="Familywise significance level")
    parser.add_argument("--selftest", action="store_true", help="Run the built-in noise/edge self-test and exit")
    args = parser.parse_args()
    if args.selftest and (not args.input and not args.output):
        args.input, args.output = "selftest-in.json", "selftest-verdict.json"

    try:
        from arch.bootstrap import SPA, StepM
        import numpy as np
    except ImportError as error:
        print(f"Missing dependency: {error}. Create research/.venv and install requirements.txt.", file=sys.stderr)
        return 2

    if args.selftest:
        rng = np.random.default_rng(42)
        # 20 pure-noise configs: SPA must NOT find an edge at alpha=0.05.
        noise = 0.0002 + rng.standard_normal((400, 20)) * 0.01
        spa = SPA(np.zeros((400, 1)), noise, reps=args.reps, seed=7)
        spa.compute()
        noise_p = float(spa.pvalues['consistent'])
        # One config with a real positive edge among noise: losses = -returns, so the
        # edge SUBTRACTS from losses. SPA must reject the no-edge null.
        with_edge = noise.copy()
        with_edge[:, 0] -= 0.0025
        spa2 = SPA(np.zeros((400, 1)), with_edge, reps=args.reps, seed=7)
        spa2.compute()
        edge_p = float(spa2.pvalues['consistent'])
        ok = noise_p > 0.05 and edge_p <= 0.05
        print(json.dumps({"selftest": ok, "noise_pvalue": noise_p, "edge_pvalue": edge_p}))
        return 0 if ok else 1

    try:
        payload = json.load(open(args.input, encoding="utf-8"))
        configs = payload["configs"]
    except Exception as error:  # noqa: BLE001 - report and fail closed
        return fail([f"Invalid input: {error}"], args.output)
    if not isinstance(configs, list) or len(configs) < MIN_CONFIGS:
        return fail([f"Need at least {MIN_CONFIGS} configs to correct for multiplicity"], args.output)
    lengths = {len(c.get("equity", [])) for c in configs}
    if len(lengths) != 1:
        return fail([f"Equity curves must share one length; got lengths {sorted(lengths)}"], args.output)
    samples = lengths.pop()
    if samples < MIN_SAMPLES + 1:
        return fail([f"Insufficient observations: {samples} equity points; need > {MIN_SAMPLES}"], args.output)
    ids = [str(c["id"]) for c in configs]
    if len(set(ids)) != len(ids):
        return fail(["Duplicate config ids"], args.output)

    equity = np.asarray([c["equity"] for c in configs], dtype=float).T  # T x N
    if not np.all(np.isfinite(equity)) or np.any(equity <= 0):
        return fail(["Equity curves must be finite and positive"], args.output)
    returns = equity[1:] / equity[:-1] - 1.0  # T-1 x N
    losses = -returns  # arch models losses relative to the benchmark
    benchmark = np.zeros((losses.shape[0], 1))  # holding cash

    # arch>=8: compute() runs the bootstrap in place; pvalues is a Series with
    # lower/consistent/upper estimates. The consistent estimate is the reported one.
    spa = SPA(benchmark, losses, reps=max(args.reps, 100), seed=42)
    spa.compute()
    spa_p = float(spa.pvalues['consistent'])
    stepm = StepM(benchmark, losses, size=args.alpha, reps=max(args.reps, 100), seed=42)
    stepm.compute()
    # superior_models lists the column indices that beat the benchmark after correction.
    survivors = list(stepm.superior_models)
    survivor_ids = [ids[int(i)] for i in survivors]
    verdict = "PASS" if spa_p <= args.alpha and survivor_ids else "FAIL"
    reasons = []
    if spa_p > args.alpha:
        reasons.append(f"SPA p-value {spa_p:.4f} above alpha {args.alpha}: no family beats cash after multiplicity correction")
    elif not survivor_ids:
        reasons.append("SPA rejected the null but StepM found no individual survivor above cash")
    result = {
        "verdict": verdict, "spa_pvalue": spa_p, "stepm_survivors": survivor_ids,
        "samples": int(losses.shape[0]), "configs": len(ids), "reps": max(args.reps, 100),
        "alpha": args.alpha, "ids": ids,
        "reasons": reasons or ["Family beats cash after SPA correction; StepM names the survivors"],
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": payload.get("source", "unspecified"),
    }
    json.dump(result, open(args.output, "w", encoding="utf-8"), indent=1)
    print(json.dumps({k: result[k] for k in ("verdict", "spa_pvalue", "stepm_survivors")}))
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
