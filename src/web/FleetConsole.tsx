import React, { useEffect, useState } from 'react';
import './fleet.css';

type ParamSpec = { key: string; label: string; min: number; max: number; default: number; integer?: boolean };
type StrategyMeta = { id: string; name: string; description: string; params: ParamSpec[]; hash: string };
type FleetBot = {
  id: string; name: string; strategyId: string; params: Record<string, number>; symbol: string; leverage: number;
  maxNotionalPerOrder: number; maxOpenNotional: number; maxOrdersPerHour: number; cooldownMs: number; maxDailyLossUsd: number;
  status: string; stats: { orders: number; fills: number; rejected: number; lastDecisionAt: string | null; lastError: string | null };
  windowSamples: number; openNotionalUsd: number; dayRealizedUsd: number;
  attribution: { realized: number; fees: number; trades: number; winRate: number; fills: number; volume: number } | null;
};
type JournalEntry = { id: number; time: string; bot_id: string; strategy_id: string; symbol: string; decision: string; side: string | null; quantity: number | null; price: number | null; rationale: string | null; error: string | null; risk_checks: { check: string; pass: boolean; detail?: string }[] | null };
type FleetState = {
  enabled: boolean;
  guard: { state: string; reason: string | null; healthyFraction: { fraction: number; samples: number } | null; counters: Record<string, number>; lastSampleAt: string | null };
  strategies: StrategyMeta[];
  bots: FleetBot[];
  journal: JournalEntry[];
  limits: { note: string; maxBots: number };
};
type Capture = { id: string; startedMs: number; frames: number; state: string; markets: { symbol: string }[] };
type ReplayResult = { netPnl: number; trades: { side: string; entry: number; exit: number; pnl: number; reason: string }[]; maxDrawdown: number; winRate: number; profitFactor: number | null; feesUsd: number; warnings: string[]; symbol: string };

const money = (v: number | null | undefined) => v == null ? '—' : v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const signed = (v: number) => `${v > 0 ? '+' : ''}${money(v)}`;
const DECISION_COLORS: Record<string, string> = { fill: 'green', 'bot-pause': 'red', reject: 'red', submit: 'green', 'guard-pause': 'red', 'guard-resume': 'green', skip: 'amber' };

export default function FleetConsole() {
  const [data, setData] = useState<FleetState | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [form, setForm] = useState<{ slug: string; name: string; strategyId: string; symbol: string; leverage: number; maxNotionalPerOrder: number; maxOpenNotional: number; maxOrdersPerHour: number; maxDailyLossUsd: number; params: Record<string, number> }>({ slug: '', name: '', strategyId: '', symbol: 'BTC', leverage: 1, maxNotionalPerOrder: 1000, maxOpenNotional: 2000, maxOrdersPerHour: 30, maxDailyLossUsd: 100, params: {} });
  const [replay, setReplay] = useState<{ captureId: string; strategyId: string; symbol: string; notionalPerOrderUsd: number; capital: number; feeBps: number }>({ captureId: '', strategyId: '', symbol: 'BTC', notionalPerOrderUsd: 1000, capital: 10000, feeBps: 2 });
  const [result, setResult] = useState<ReplayResult | null>(null);
  const refresh = async () => { const r = await fetch('/api/fleet'); if (!r.ok) throw new Error('Unable to read fleet state'); setData(await r.json()); };
  useEffect(() => {
    refresh().catch(e => setError(e.message));
    fetch('/api/feeds/lighter/captures').then(r => r.json()).then(c => setCaptures(c.captures ?? [])).catch(() => {});
    const timer = setInterval(() => refresh().catch(e => setError(e.message)), 3000);
    return () => clearInterval(timer);
  }, []);
  const act = async (path: string, body: unknown) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const res = await r.json(); if (!r.ok) throw new Error(res.error || 'Request failed');
      setNotice(res.bots ? 'Fleet updated.' : 'Done.'); await refresh(); return res;
    } catch (e) { setError((e as Error).message); await refresh().catch(() => {}); } finally { setBusy(false); }
  };
  if (!data) return <section className="panel">{error || 'Connecting to the fleet control plane…'}</section>;
  const strategy = data.strategies.find(s => s.id === (form.strategyId || data.strategies[0]?.id));
  const active = data.bots.filter(b => b.status === 'running').length;
  const dayPnl = data.bots.reduce((s, b) => s + b.dayRealizedUsd, 0);
  const realized = data.bots.reduce((s, b) => s + (b.attribution?.realized ?? 0), 0);
  const orders = data.bots.reduce((s, b) => s + b.stats.orders, 0), fills = data.bots.reduce((s, b) => s + b.stats.fills, 0);
  const metric = (label: string, value: string, note: string, pnl = false) => <div className="metric"><span>{label}</span><strong className={pnl ? (value.startsWith('-') ? 'red' : 'green') : ''}>{value}</strong><small>{note}</small></div>;
  const replayStrategy = data.strategies.find(s => s.id === (replay.strategyId || data.strategies[0]?.id));
  return <div className="fleet-console">
    <div className="fleet-kpis">{metric('FLEET DAY P&L', signed(dayPnl), 'Closing-leg attribution · UTC day', true)}{metric('FLEET REALIZED', signed(realized), 'All closed bot legs', true)}{metric('ACTIVE BOTS', `${active}/${data.bots.length}`, `${orders} orders · ${fills} fills`)}{metric('FEED HEALTH', data.guard.state.toUpperCase(), data.guard.healthyFraction ? `${(data.guard.healthyFraction.fraction * 100).toFixed(2)}% healthy · ${data.guard.counters.disconnects ?? 0} disconnects` : 'waiting for samples', true)}</div>
    {error && <div className="error" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
    {notice && <div className="banner" role="status">{notice}</div>}
    <section className="panel"><div className="row"><div><h3>Automation authority</h3><p className="hint">{data.limits.note}</p></div>{data.enabled ? <button className="danger" disabled={busy} onClick={() => act('fleet/disable', {})}>■ Disable paper automation</button> : <button className="primary" disabled={busy} onClick={() => { if (confirm('Authorize PAPER automation for this session? Bots will submit real paper IOC orders through the shared executor, inside every existing risk limit. Authorization clears on restart and never touches live signing.')) act('fleet/enable', { confirm: 'ENABLE PAPER AUTOMATION' }); }}>▷ Enable paper automation</button>}</div>
      <div className="fleet-guard">{['state', 'reason'].map(() => null)}<span className={`badge ${data.guard.state === 'healthy' ? 'running' : 'paper'}`}>GUARD: {data.guard.state.toUpperCase()}</span><span className="hint">{data.guard.reason ?? 'Open exposure permitted'}</span><span className="hint mono">sampled {data.guard.lastSampleAt ? new Date(data.guard.lastSampleAt).toLocaleTimeString() : '—'}</span></div></section>
    <section className="panel"><div className="row"><h3>Bots</h3><span className="badge">PAPER ONLY · SHARED EXECUTOR</span></div>
      <div className="table-scroll"><table><thead><tr>{['Bot', 'Strategy', 'Market', 'Status', 'Orders / fills', 'Day P&L', 'Realized', 'Open notional', 'Last decision', 'Actions'].map(h => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{data.bots.map(b => <tr key={b.id}>
          <td><strong>{b.name}</strong><small className="muted" style={{ display: 'block' }}>{b.id}{b.stats.lastError ? ` · ${b.stats.lastError}` : ''}</small></td>
          <td>{b.strategyId}<small className="muted" style={{ display: 'block' }}>{Object.entries(b.params).map(([k, v]) => `${k}=${v}`).join(' · ') || 'default params'}</small></td>
          <td>{b.symbol}<small className="muted" style={{ display: 'block' }}>{b.leverage}× · {b.windowSamples} samples</small></td>
          <td><span className={`badge ${b.status === 'running' ? 'running' : b.status === 'halted' ? 'halted' : 'paper'}`}>{b.status}</span></td>
          <td className="mono">{b.stats.orders} / {b.stats.fills}{b.stats.rejected ? <span className="red"> · {b.stats.rejected} rejected</span> : null}</td>
          <td className={`mono ${b.dayRealizedUsd < 0 ? 'red' : 'green'}`}>{signed(b.dayRealizedUsd)}</td>
          <td className={`mono ${(b.attribution?.realized ?? 0) < 0 ? 'red' : 'green'}`}>{b.attribution ? signed(b.attribution.realized) : '—'}<small className="muted" style={{ display: 'block' }}>{b.attribution ? `${b.attribution.trades} closed · PF n/a` : 'no closed legs'}</small></td>
          <td className="mono">{money(b.openNotionalUsd)}<small className="muted" style={{ display: 'block' }}>cap {money(b.maxOpenNotional)}</small></td>
          <td className="mono muted">{b.stats.lastDecisionAt ? new Date(b.stats.lastDecisionAt).toLocaleTimeString() : '—'}</td>
          <td>{b.status === 'running' ? <button disabled={busy} onClick={() => act('fleet/pause', { id: b.id })}>Pause</button> : <button disabled={busy} onClick={() => act('fleet/start', { id: b.id })}>Start</button>} <button className="danger" disabled={busy} onClick={() => { if (confirm(`Delete ${b.id}? Its decision journal history is kept.`)) act('fleet/delete', { id: b.id }); }}>Delete</button></td>
        </tr>)}</tbody></table>{!data.bots.length && <div className="empty">No bots yet. Create one below — it starts paused and warm before any order.</div>}</div></section>
    <div className="fleet-grid">
      <section className="panel"><h3>New bot</h3><p className="hint">Direction proposals only: the strategy never sizes orders. The runner sizes within your caps, and the paper executor keeps final authority.</p>
        <label>Slug (unique id)<input value={form.slug} onChange={e => setForm({ ...form, slug: e.target.value })} placeholder="breakout-btc"/></label>
        <label>Display name<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="optional"/></label>
        <label>Strategy<select value={form.strategyId || data.strategies[0]?.id} onChange={e => setForm({ ...form, strategyId: e.target.value, params: {} })}>{data.strategies.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        {strategy && <p className="hint">{strategy.description}</p>}
        {strategy?.params.map(p => <label key={p.key}>{p.label}<input type="number" step="any" value={form.params[p.key] ?? p.default} onChange={e => setForm({ ...form, params: { ...form.params, [p.key]: Number(e.target.value) } })}/></label>)}
        <label>Market symbol<input value={form.symbol} onChange={e => setForm({ ...form, symbol: e.target.value.toUpperCase() })}/></label>
        <div className="fleet-caps">{[['leverage', 'Leverage'], ['maxNotionalPerOrder', 'Per-order cap $'], ['maxOpenNotional', 'Open notional cap $'], ['maxOrdersPerHour', 'Max orders / hour'], ['maxDailyLossUsd', 'Daily loss stop $']].map(([key, label]) => <label key={key}>{label}<input type="number" value={(form as any)[key]} onChange={e => setForm({ ...form, [key]: Number(e.target.value) })}/></label>)}</div>
        <button className="primary full" disabled={busy || !form.slug} onClick={() => act('fleet/create', form)}>＋ Create bot (paused)</button></section>
      <section className="panel"><h3>Replay a recorded capture</h3><p className="hint">Deterministic no-look-ahead replay over a bounded recorded prefix: signals fill at the next book update's top of book. Evidence, not execution proof.</p>
        <label>Capture<select value={replay.captureId} onChange={e => { const c = captures.find(x => x.id === e.target.value); setReplay({ ...replay, captureId: e.target.value, symbol: c?.markets[0]?.symbol ?? replay.symbol }); }}>{captures.length ? captures.map(c => <option key={c.id} value={c.id}>{new Date(c.startedMs).toLocaleString()} · {c.frames} frames · {c.markets.map(m => m.symbol).join('/')} · {c.state}</option>) : <option value="">No captures recorded yet</option>}</select></label>
        <label>Strategy<select value={replay.strategyId || data.strategies[0]?.id} onChange={e => setReplay({ ...replay, strategyId: e.target.value })}>{data.strategies.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Market in capture<input value={replay.symbol} onChange={e => setReplay({ ...replay, symbol: e.target.value.toUpperCase() })}/></label>
        <div className="fleet-caps"><label>Notional per order $<input type="number" value={replay.notionalPerOrderUsd} onChange={e => setReplay({ ...replay, notionalPerOrderUsd: Number(e.target.value) })}/></label><label>Capital $<input type="number" value={replay.capital} onChange={e => setReplay({ ...replay, capital: Number(e.target.value) })}/></label><label>Fee (bps)<input type="number" value={replay.feeBps} onChange={e => setReplay({ ...replay, feeBps: Number(e.target.value) })}/></label></div>
        <button className="full" disabled={busy || !replay.captureId} onClick={async () => { const res = await act('fleet/backtest', replay); if (res?.result) setResult(res.result); }}>▷ Run replay</button>
        {result && <><div className="metrics compact">{metric('NET P&L', signed(result.netPnl), `${result.trades.length} trades`, true)}{metric('MAX DRAWDOWN', `${(result.maxDrawdown * 100).toFixed(2)}%`, 'On replayed equity')}{metric('WIN RATE', `${(result.winRate * 100).toFixed(1)}%`, `Fees ${money(result.feesUsd)}`)}{metric('PROFIT FACTOR', result.profitFactor?.toFixed(2) ?? 'N/A', result.symbol)}</div><div className="warnings">{result.warnings.map(w => <p key={w}>△ {w}</p>)}</div><div className="table-scroll"><table><thead><tr>{['Side', 'Entry', 'Exit', 'Net P&L', 'Reason'].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{result.trades.map((t, i) => <tr key={i}><td className={t.side === 'long' ? 'green' : 'red'}>{t.side}</td><td className="mono">{money(t.entry)}</td><td className="mono">{money(t.exit)}</td><td className={`mono ${t.pnl < 0 ? 'red' : 'green'}`}>{signed(t.pnl)}</td><td>{t.reason}</td></tr>)}</tbody></table></div><p className="hint">Saved to experiments — register it as a paper strategy from the Backtest lab.</p></>}</section>
    </div>
    <section className="panel"><div className="row"><h3>Decision journal</h3><span className="badge">EVERY AUTOMATED DECISION + RISK CHECKS</span></div>
      <div className="table-scroll"><table><thead><tr>{['Time', 'Bot', 'Decision', 'Order', 'Rationale', 'Risk checks'].map(h => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{data.journal.map(j => <tr key={j.id}>
          <td className="mono muted">{new Date(j.time).toLocaleTimeString()}</td>
          <td>{j.bot_id}<small className="muted" style={{ display: 'block' }}>{j.strategy_id}</small></td>
          <td><span className={`badge ${DECISION_COLORS[j.decision] ?? ''}`}>{j.decision}</span></td>
          <td className="mono">{j.side ? `${j.side.toUpperCase()} ${j.quantity ?? ''}` : '—'}{j.price ? <small className="muted" style={{ display: 'block' }}>{money(j.price)}</small> : null}</td>
          <td style={{ whiteSpace: 'normal', minWidth: 260 }}>{j.rationale}{j.error && <small className="red" style={{ display: 'block' }}>{j.error}</small>}</td>
          <td>{j.risk_checks?.length ? j.risk_checks.map(c => <small key={c.check} className={c.pass ? 'green' : 'red'} style={{ display: 'block' }}>{c.pass ? '✓' : '✗'} {c.check}{c.detail ? ` · ${c.detail}` : ''}</small>) : '—'}</td>
        </tr>)}</tbody></table>{!data.journal.length && <div className="empty">No decisions journaled yet.</div>}</div></section>
  </div>;
}
