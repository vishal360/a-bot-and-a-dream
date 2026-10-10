import React, { useEffect, useState } from 'react';
type Policy = { allocationPct: number; dailyLossPct: number; maxLeverage: number; executionEnabled: boolean };
type Preview = Policy & { equity: number | null; marginBudget: number | null; snapshotTime: string | null; network: string | null; accountIndex: number | null; status: string; reason: string };
export default function PortfolioAllocation() {
  const [saved, setSaved] = useState<Policy | null>(null), [pct, setPct] = useState(0), [preview, setPreview] = useState<Preview | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/risk/allocation', { signal: controller.signal }).then(async r => { if (!r.ok) throw new Error('Could not load allocation policy'); const p: Policy = await r.json(); setSaved(p); setPct(p.allocationPct); }).catch(e => { if (!controller.signal.aborted) setMessage(e.message); });
    const poll = async () => {
      try { const r = await fetch('/api/risk/allocation/preview', { signal: controller.signal }); if (!r.ok) throw new Error('Could not load account allocation preview'); setPreview(await r.json()); }
      catch (e) { if (!controller.signal.aborted) { setPreview(null); setMessage((e as Error).message); } }
    };
    void poll(); const timer = setInterval(() => void poll(), 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  const save = async () => {
    setBusy(true); setMessage('');
    try {
      const r = await fetch('/api/risk/allocation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allocationPct: pct }) });
      const p = await r.json(); if (!r.ok) throw new Error(p.error); setSaved(p); setMessage('Allocation policy saved. Venue execution remains disabled.');
    } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); }
  };
  const refresh = async () => {
    setBusy(true); setPreview(null); setMessage('');
    try {
      const r = await fetch('/api/lighter/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await r.json(); if (!r.ok) throw new Error(data.error);
      const p = await fetch('/api/risk/allocation/preview'); if (!p.ok) throw new Error('Could not load refreshed preview'); setPreview(await p.json());
    } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); }
  };
  const age = preview?.snapshotTime ? Date.now() - Date.parse(preview.snapshotTime) : NaN;
  const usable = preview?.status === 'public-snapshot' && Number.isFinite(age) && age >= 0 && age <= 30000 && preview.equity !== null;
  const money = (v: number) => v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  return <section className="panel">
    <span className="eyebrow">PORTFOLIO-WIDE ALLOCATION</span><h2>Combined trading budget</h2>
    <p>The saved percentage also bounds exposure in the separate local BTC simulation, using simulated equity—not the venue balance below. That interim simulator is long-only and 1×. Future leveraged execution must reconcile combined positions and pending reservations before enabling agents.</p>
    <label htmlFor="portfolio-allocation">Maximum combined margin allocation: <strong>{pct}%</strong></label>
    <input id="portfolio-allocation" type="range" min="0" max="100" step="1" value={pct} disabled={!saved || busy} aria-valuetext={`${pct}% of current account equity across all trades`} onChange={e => setPct(Number(e.target.value))}/>
    <p>Saved limit: {saved ? `${saved.allocationPct}%` : 'Loading…'} · 0% means no new exposure.</p>
    <h3>Latest public venue account snapshot</h3>
    {usable && preview ? <>
      <p>{preview.network} · account {preview.accountIndex} · read at {preview.snapshotTime}</p>
      <p>Reported total asset value: <strong>{money(preview.equity!)}</strong>. Budget at selected {pct}%: <strong>{money(preview.equity! * pct / 100)}</strong>; equity outside that budget: {money(preview.equity! * (1 - pct / 100))}.</p>
      <p>Saved-policy margin budget: {money(preview.equity! * (saved?.allocationPct ?? 0) / 100)}. This is not remaining buying power; existing margin and pending orders have not been reconciled.</p>
    </> : <p role="status">Budget unavailable: {preview?.status === 'public-snapshot' ? 'Account snapshot is stale. Refresh it.' : preview?.reason ?? 'Waiting for account data; no demo balance is substituted.'}</p>}
    <button disabled={busy} onClick={() => void refresh()}>Refresh venue account balance</button>
    <button disabled={!saved || busy || saved.allocationPct === pct} onClick={() => void save()}>Save portfolio allocation</button>
    <p role="status">{message}</p>
    <p>Daily loss policy: {saved?.dailyLossPct ?? 6}% of start-of-day equity (UTC), including realized/unrealized losses, fees and funding, adjusted for cash transfers. Leverage ceiling: {saved?.maxLeverage ?? 20}×, subject to venue limits; per-position leverage and sizing remain undecided.</p>
    <p className="amber">Public venue snapshots do not authenticate the key or establish local simulated equity. Manual local BTC paper IOC orders have cash/allocation checks; venue orders and agents remain disabled. Lowering allocation does not close positions. The local loss baseline is the first observation of a UTC day, not a verified midnight baseline; funding and leverage are not modeled.</p>
  </section>;
}