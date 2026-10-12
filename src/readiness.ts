export function readiness(paperRiskDays?: { current: { midnightVerified: boolean; kind: string } | null; blocked: boolean }) {
  return {
    executionEnabled: false, agentsEnabled: false, readyThroughStep4: false,
    automation: {
      authorized: false, nextStage: 'read-only acceptance and offline strategy research',
      baseline: { status: paperRiskDays?.blocked ? 'blocked' : paperRiskDays?.current?.midnightVerified ? 'verified-local-flat-boundary' : 'incomplete',
        kind: paperRiskDays?.current?.kind ?? null, scope: 'fixed-capital local paper only; not perpetual or venue reconciliation' },
      blockers: ['Funding history timestamp/position ordering is unverified; settlement is delayed and liquidation uses an approximate depth IOC, not venue LLP/ADL',
        'Overnight-position UTC baseline and complete cash-flow provenance are not verified',
        'Sustained mainnet acceptance and operational failure drills require recorded runtime evidence',
        'No approved versioned strategy, untouched holdout or paper-forward evidence',
        'Isolated proposal workers and bounded central autonomous paper authority are not enabled'],
      liveSigningEnabled: false,
    },
    gates: [
      { step: 2, status: 'incomplete', required: ['Validated mainnet depth/trade/funding feed with sequence-gap detection', 'Recorded data provenance and freshness controls', 'Browser workflow and archive security acceptance'] },
      { step: 3, status: 'incomplete', required: ['Precision/minimum validation and realistic local depth/queue matching', 'Durable simulated order/cancel/fill/funding accounting and restart recovery', 'Connected central paper risk authority with verified UTC baseline and cash flows', 'Disconnect/restart and matching failure drills'] },
      { step: 4, status: 'incomplete', required: ['Provenance-verified historical data and funding', 'Realistic fees/slippage and frozen holdout/walk-forward evidence', 'Sustained mainnet-data local paper forward testing'] }
    ]
  };
}