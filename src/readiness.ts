export function readiness() {
  return {
    executionEnabled: false, agentsEnabled: false, readyThroughStep4: false,
    gates: [
      { step: 2, status: 'incomplete', required: ['Validated mainnet depth/trade/funding feed with sequence-gap detection', 'Recorded data provenance and freshness controls', 'Browser workflow and archive security acceptance'] },
      { step: 3, status: 'incomplete', required: ['Precision/minimum validation and realistic local depth/queue matching', 'Durable simulated order/cancel/fill/funding accounting and restart recovery', 'Connected central paper risk authority with verified UTC baseline and cash flows', 'Disconnect/restart and matching failure drills'] },
      { step: 4, status: 'incomplete', required: ['Provenance-verified historical data and funding', 'Realistic fees/slippage and frozen holdout/walk-forward evidence', 'Sustained mainnet-data local paper forward testing'] }
    ]
  };
}