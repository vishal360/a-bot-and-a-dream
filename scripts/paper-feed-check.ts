import { Store } from '../src/store';
import { Operations } from '../src/operations';
import { ExecutionRisk } from '../src/execution-risk';
import { Paper } from '../src/paper';
// Real public reads only. No simulated or venue orders; no operator database changes.
const store = new Store(':memory:');
new Operations(store, {} as any); new ExecutionRisk(store);
try {
  const observation = await new Paper(store).observe();
  await Bun.write('paper-feed-check.log', JSON.stringify({ status: 'PASS', time: observation.time, market: observation.market, bid: observation.bids[0], ask: observation.asks[0], venueOrdersSent: 0 }, null, 2));
} catch (e) {
  await Bun.write('paper-feed-check.log', JSON.stringify({ status: 'FAIL', error: (e as Error).message, venueOrdersSent: 0 }, null, 2));
  process.exitCode = 1;
} finally { store.db.close(); }