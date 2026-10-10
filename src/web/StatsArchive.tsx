import React, { useEffect, useState } from 'react';
export default function StatsArchive({ onReset }: { onReset: () => Promise<void> }) {
  const [archives, setArchives] = useState<{ id: string; time: string }[]>([]), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const load = async () => { const r = await fetch('/api/stats/archives'); if (!r.ok) throw new Error('Could not load archives'); setArchives(await r.json()); };
  useEffect(() => { void load().catch(e => setMessage(e.message)); }, []);
  const reset = async () => {
    if (prompt('Type ARCHIVE AND RESET to archive the local ledger and clear P&L, marks, alerts and heartbeats. Recorded positions must be flat. Venue, credentials, research, risk and halt are unchanged.') !== 'ARCHIVE AND RESET') return;
    setBusy(true); setMessage('');
    try {
      const r = await fetch('/api/stats/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'ARCHIVE AND RESET' }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error);
      await onReset(); await load(); setMessage(`Archived and reset. Archive ID: ${d.id}`);
    } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); }
  };
  return <section className="panel"><h3>Archive & reset local statistics</h3><p>Archives all recorded fills in SQLite before resetting local P&L, fills, marks, alerts and heartbeats. Does not reset venue balances or close positions. Recorded open positions block reset to preserve cost basis. Credentials, risk policy, emergency halt, audit and research runs remain.</p><button disabled={busy} onClick={() => void reset()}>Archive data & reset P&L stats</button><p role="status">{message}</p><h4>Saved archives</h4>{archives.map(a => <p key={a.id}><a href={`/api/stats/archive?id=${encodeURIComponent(a.id)}`} download={`ledger-${a.id}.json`}>Download archive · {a.time}</a></p>)}{!archives.length && <p>No archives yet.</p>}</section>;
}