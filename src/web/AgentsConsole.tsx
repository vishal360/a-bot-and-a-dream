import React, { useEffect, useState } from 'react';
import './agents.css';

type JournalEntry = {
  id: number; time: string; bot_id: string; strategy_id: string; symbol: string; decision: string;
  rationale: string | null; inputs: Record<string, any> | null;
  risk_checks: { check: string; pass: boolean; detail?: string }[] | null;
};
type OpenShadow = {
  id: string; agentId: string; symbol: string; direction: 'long' | 'short'; confidence: number;
  markAt: number; rationale: string; createdAt: string; expiresAtMs: number;
};
type AgentStatus = {
  enabled: boolean; apiKeyPresent: boolean;
  models: { agentId: string; model: string }[];
  requests: { day: string; used: number; cap: number };
  pendingShadow: number; pendingShadowList: OpenShadow[];
  personaPending: number; personaPendingList: OpenShadow[];
  intervalMs: number; lastTickAt: string | null; failures: string[];
};
type Activity = {
  status: AgentStatus; entries: JournalEntry[];
  marks: Record<string, number>;
  open: { ensemble: OpenShadow[]; personas: OpenShadow[] };
};

const DIRECTION_CLASS: Record<string, string> = { long: 'green', short: 'red', flat: 'amber' };
const PERSONAS: Record<string, { name: string; role: string }> = {
  'agent-gemini-momentum': { name: 'Momentum', role: 'continuation analyst' },
  'agent-gemini-skeptic': { name: 'Skeptic', role: 'conservative risk analyst' },
  'agent-gemini-flow': { name: 'Flow', role: 'microstructure analyst' },
  'agent-ensemble': { name: 'Ensemble', role: '2-of-3 quorum' },
};
const timeAgo = (iso: string | null | undefined) => {
  if (!iso || !Date.parse(iso)) return '—';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const countdown = (expiresAtMs: number) => {
  const s = Math.max(0, Math.round((expiresAtMs - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

export default function AgentsConsole() {
  const [data, setData] = useState<Activity | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const refresh = async () => { const r = await fetch('/api/agents/activity'); if (!r.ok) throw new Error('Unable to read agent activity'); setData(await r.json()); };
  useEffect(() => {
    refresh().catch(e => setError(e.message));
    const timer = setInterval(() => refresh().catch(e => setError(e.message)), 5000);
    return () => clearInterval(timer);
  }, []);
  const act = async (path: string, body: unknown) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const res = await r.json(); if (!r.ok) throw new Error(res.error || 'Request failed');
      setNotice('Done.'); await refresh(); return res;
    } catch (e) { setError((e as Error).message); await refresh().catch(() => {}); } finally { setBusy(false); }
  };
  if (!data) return <section className="panel">{error || 'Connecting to the agent control plane…'}</section>;

  const { status, entries, marks, open } = data;
  const enabled = status.enabled;
  const personaOutcomes = entries.filter(e => e.decision === 'agent-outcome' && e.bot_id !== 'agent-ensemble');
  const ensembleOutcomes = entries.filter(e => e.decision === 'agent-outcome' && e.bot_id === 'agent-ensemble');
  const correctOf = (list: JournalEntry[]) => list.filter(o => (o.inputs as any)?.grade === 'correct' || (o.rationale ?? '').includes('direction correct')).length;
  const personaScore = status.models.map(m => {
    const mine = personaOutcomes.filter(o => o.bot_id === m.agentId);
    const proposals = entries.filter(e => e.bot_id === m.agentId && e.decision === 'agent-proposal');
    const correct = correctOf(mine);
    const confs = mine.map(o => (o.inputs as any)?.confidence).filter((c: any) => typeof c === 'number');
    const votes = proposals.slice(0, 12).map(e => (e.inputs as any)?.direction ?? '?');
    return { agentId: m.agentId, model: m.model, proposals: proposals.length, graded: mine.length, correct,
      hitRate: mine.length ? correct / mine.length : null, avgConfidence: confs.length ? confs.reduce((s, c) => s + c, 0) / confs.length : null, votes };
  });
  const confidenceHonesty = {
    correct: ensembleOutcomes.filter(o => correctOf([o]) === 1).map(o => (o.inputs as any)?.confidence).filter((c: any) => typeof c === 'number'),
    wrong: ensembleOutcomes.filter(o => correctOf([o]) === 0).map(o => (o.inputs as any)?.confidence).filter((c: any) => typeof c === 'number'),
  };
  const avg = (list: number[]) => list.length ? list.reduce((s, v) => s + v, 0) / list.length : null;
  const cycles = entries.filter(e => e.bot_id === 'agent-ensemble' && (e.decision === 'agent-proposal' || e.decision === 'skip')).slice(0, 10);
  const disagreementRate = cycles.length ? Math.round(cycles.filter(c => c.decision === 'skip').length / cycles.length * 100) : null;
  const ensembleProposal = entries.find(e => e.bot_id === 'agent-ensemble' && e.decision === 'agent-proposal');
  const ensembleVeto = entries.find(e => e.bot_id === 'agent-ensemble' && e.decision === 'skip');
  const ensembleInputs = (ensembleProposal?.inputs ?? {}) as { direction?: string; confidence?: number; mark?: number; agreeing?: string; dissenting?: string };
  const personas = status.models.map(m => {
    const mine = entries.filter(e => e.bot_id === m.agentId);
    const proposal = mine.find(e => e.decision === 'agent-proposal');
    const rejection = mine.find(e => e.decision === 'agent-reject');
    const score = personaScore.find(p => p.agentId === m.agentId)!;
    return { agentId: m.agentId, model: m.model, proposal, rejection, score, votes: score.votes };
  });
  const liveEnsemble = open.ensemble[0] ?? null;
  const liveMark = liveEnsemble ? marks[liveEnsemble.symbol] : undefined;
  const liveMove = liveEnsemble && liveMark !== undefined
    ? (liveEnsemble.direction === 'long' ? 1 : -1) * (liveMark - liveEnsemble.markAt) / liveEnsemble.markAt * 100 : null;
  const metric = (label: string, value: string, note: string, tone = '') => <div className="metric"><span>{label}</span><strong className={tone}>{value}</strong><small>{note}</small></div>;
  const chip = (label: string, cls: string) => <span className={`badge ${cls}`}>{label}</span>;
  const voteChip = (direction: string | null | undefined, confidence?: number) => {
    if (!direction || direction === 'flat') return <span className="badge amber">{(direction ?? 'NO VOTE').toUpperCase()}</span>;
    return <span className={`badge ${DIRECTION_CLASS[direction]}`}>{direction.toUpperCase()}{typeof confidence === 'number' ? ` · ${(confidence * 100).toFixed(0)}%` : ''}</span>;
  };
  const moveSpan = (move: number | null) => move === null ? null : <strong className={move > 0 ? 'green' : move < 0 ? 'red' : ''}>{pct(move)}</strong>;

  return <div className="fleet-console agents-console">
    <div className="fleet-kpis">
      {metric('SHADOW MODE', enabled ? 'LIVE' : 'OFF', enabled ? 'journal-only · no orders' : 'agents idle — enable below', enabled ? '' : 'red')}
      {metric('MODEL REQUESTS', `${status.requests.used}/${status.requests.cap}`, `resets UTC ${status.requests.day}`)}
      {metric('OPEN ENSEMBLE CALLS', String(open.ensemble.length), liveEnsemble ? `${liveEnsemble.direction.toUpperCase()} · live ${pct(liveMove!)}` : 'none open right now')}
      {metric('GRADED HIT RATE', ensembleOutcomes.length ? `${Math.round(correctOf(ensembleOutcomes) / ensembleOutcomes.length * 100)}%` : '—', `${correctOf(ensembleOutcomes)}/${ensembleOutcomes.length} ensemble calls correct`, ensembleOutcomes.length ? (correctOf(ensembleOutcomes) / ensembleOutcomes.length >= 0.5 ? 'green' : 'red') : '')}
    </div>
    {error && <div className="error" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
    {notice && <div role="status" className="banner">{notice}</div>}
    {!enabled && <div className="banner agents-off-banner">
      <div><strong>Shadow mode is OFF.</strong> The three analysts are idle — nothing is proposed, voted or graded. Enable it to start collecting their opinions and grading them against reality. Journal-only: no orders, ever, from this page.</div>
      <button className="primary" disabled={busy} onClick={() => act('agents/enable', { confirm: 'ENABLE AGENT SHADOW' })}>Enable shadow mode</button>
    </div>}

    <section className="panel">
      <div className="row"><h3>Live opinions — watched as they play out</h3><span className="badge">{(open.ensemble.length + open.personas.length)} open</span></div>
      {open.ensemble.length
        ? <div className="live-grid">
            {open.ensemble.map(o => {
              const markNow = marks[o.symbol];
              const move = markNow === undefined ? null : (o.direction === 'long' ? 1 : -1) * (markNow - o.markAt) / o.markAt * 100;
              return <div className="panel live-card" key={o.id}>
                <div className="row"><strong>ENSEMBLE · {o.symbol}</strong>{chip(o.direction.toUpperCase(), DIRECTION_CLASS[o.direction])}</div>
                <div className="live-nums">
                  <div><small>opened at</small><strong>{o.markAt.toFixed(2)}</strong></div>
                  <div><small>live mark</small><strong>{markNow === undefined ? '—' : markNow.toFixed(2)}</strong></div>
                  <div><small>move so far</small><strong>{move === null ? '—' : moveSpan(move)}</strong></div>
                  <div><small>expires in</small><strong className="mono">{countdown(o.expiresAtMs)}</strong></div>
                </div>
                <p className="rationale">{o.rationale} · confidence {(o.confidence * 100).toFixed(0)}%</p>
              </div>;
            })}
          </div>
        : <p className="empty">{enabled ? 'No ensemble opinion is open right now — the next cycle opens one when 2-of-3 agree.' : 'Shadow mode is off.'}</p>}
      {!!open.personas.length && <div className="table-scroll"><table><thead><tr><th>Analyst</th><th>Symbol</th><th>Vote</th><th>Opened at</th><th>Live move</th><th>Expires in</th></tr></thead>
        <tbody>{open.personas.map(o => {
          const markNow = marks[o.symbol];
          const move = markNow === undefined ? null : (o.direction === 'long' ? 1 : -1) * (markNow - o.markAt) / o.markAt * 100;
          return <tr key={o.id}><td>{PERSONAS[o.agentId]?.name ?? o.agentId}</td><td>{o.symbol}</td>
            <td>{chip(o.direction.toUpperCase(), DIRECTION_CLASS[o.direction])}</td><td>{o.markAt.toFixed(2)}</td>
            <td>{move === null ? '—' : moveSpan(move)}</td><td className="mono">{countdown(o.expiresAtMs)}</td></tr>;
        })}</tbody></table></div>}
    </section>

    <div className="fleet-grid">
      <section className="panel">
        <div className="row"><h3>The three analysts — latest votes</h3><span className="badge">{enabled ? 'SHADOW LIVE' : 'SHADOW OFF'}</span></div>
        <p className="muted">Each persona reads the same market context and votes independently. Two of three must agree on a direction before anything is even considered — and in shadow mode nothing is considered for execution anyway.</p>
        <div className="agents-grid">
          {personas.map(p => {
            const inputs = (p.proposal?.inputs ?? {}) as { direction?: string; confidence?: number; horizonSeconds?: number; mark?: number };
            const rationaleOwn = p.proposal ? null : p.rejection;
            return <article className="panel agent-card" key={p.agentId}>
              <div className="row"><strong>{PERSONAS[p.agentId]?.name ?? p.agentId}</strong>{voteChip(inputs.direction, inputs.confidence)}</div>
              <p className="muted small">{PERSONAS[p.agentId]?.role ?? 'analyst'} · {p.model}</p>
              <div className="conf-track"><div className="conf-fill" style={{ width: `${(inputs.confidence ?? 0) * 100}%` }}/></div>
              <p className="rationale">{p.proposal ? p.proposal.rationale : p.rejection ? <span className="red">Last cycle: {p.rejection.rationale}</span> : 'No proposal yet — enable shadow mode and run a cycle.'}</p>
              <div className="vote-strip">{p.votes.map((v, i) => <span key={i} className={`vote-cell ${DIRECTION_CLASS[v] ?? 'amber'}`} title={v}>{v === 'long' ? '▲' : v === 'short' ? '▼' : '■'}</span>)}</div>
              <div className="agent-meta">
                <small>hit rate {p.score.hitRate === null ? '—' : `${Math.round(p.score.hitRate * 100)}%`} · avg conf {p.score.avgConfidence === null ? '—' : `${(p.score.avgConfidence * 100).toFixed(0)}%`}</small>
                <small>{timeAgo(p.proposal?.time)} · {p.score.proposals} proposals</small>
              </div>
            </article>;
          })}
        </div>
        <p className="muted small">Rationale text is the model's own words — evidence of what the agents were thinking, not a promise. The scorecard judges them on outcomes.</p>
      </section>

      <section className="panel">
        <div className="row"><h3>Ensemble &amp; veto</h3><span className="badge">{ensembleVeto && (!ensembleProposal || entries.findIndex(e => e.id === ensembleVeto.id) < entries.findIndex(e => e.id === ensembleProposal.id)) ? 'VETOED' : ensembleProposal ? 'QUORUM' : 'NO CYCLES'}</span></div>
        {ensembleProposal && <>
          <div className="quorum-row">
            <div className="quorum-visual">{[0, 1, 2].map(i => <span key={i} className={`quorum-dot${i < (ensembleInputs.agreeing ? String(ensembleInputs.agreeing).split(', ').length : 0) ? ' filled' : ''}`}/>)}<strong>{ensembleInputs.agreeing ? String(ensembleInputs.agreeing).split(', ').length : 0}/3</strong></div>
            <div>{chip((ensembleInputs.direction ?? '').toUpperCase(), DIRECTION_CLASS[ensembleInputs.direction ?? 'flat'])}<p className="muted small">ensemble confidence {(100 * (ensembleInputs.confidence ?? 0)).toFixed(0)}% · mark {typeof ensembleInputs.mark === 'number' ? ensembleInputs.mark.toFixed(2) : '—'}</p></div>
          </div>
          <p className="muted">Agreeing: {ensembleInputs.agreeing || '—'}{ensembleInputs.dissenting ? <> · Dissenting (veto vote): <strong>{ensembleInputs.dissenting}</strong></> : <> · no dissent</>}</p>
        </>}
        {ensembleVeto && <div className="veto-box"><strong>Last veto:</strong> {ensembleVeto.rationale} <small className="muted">({timeAgo(ensembleVeto.time)})</small></div>}
        <p className="muted small">Recent cycles: {cycles.map(c => chip(c.decision === 'skip' ? 'VETO' : `QUORUM ${((c.inputs as any)?.direction ?? '').toUpperCase()}`, c.decision === 'skip' ? 'red' : 'green'))}</p>
        {disagreementRate !== null && <p className="muted small">Disagreement rate over the last {cycles.length} cycles: <strong>{disagreementRate}%</strong> — disagreement is the ensemble working, not a fault.</p>}
        <p className="muted small">Shadow outcomes are graded at expiry against the real mark — correct/wrong only, no money moves.</p>
        <div className="row wrap">
          <button disabled={busy} onClick={() => act('agents/tick', {})}>▶ Run one cycle now</button>
          {enabled
            ? <button className="danger" disabled={busy} onClick={() => act('agents/disable', {})}>Disable shadow</button>
            : <button className="primary" disabled={busy} onClick={() => act('agents/enable', { confirm: 'ENABLE AGENT SHADOW' })}>Enable shadow mode</button>}
        </div>
        <p className="muted small">Requests: {status.requests.used}/{status.requests.cap} today · cycle every {Math.round(status.intervalMs / 1000)}s · key {status.apiKeyPresent ? 'present' : 'MISSING'} · last cycle {timeAgo(status.lastTickAt)}</p>
        {!!status.failures.length && <div className="warnings">{status.failures.map((f, i) => <p key={i}>⚠ {f}</p>)}</div>}
      </section>
    </div>

    <section className="panel">
      <div className="row"><h3>Analyst scorecard — who deserves trust</h3><span className="badge">{personaOutcomes.length} graded votes</span></div>
      {personaOutcomes.length
        ? <div className="table-scroll"><table><thead><tr><th>Analyst</th><th>Model</th><th>Proposals</th><th>Graded</th><th>Correct</th><th>Hit rate</th><th>Avg confidence</th></tr></thead>
          <tbody>{personaScore.map(p => <tr key={p.agentId}><td><strong>{PERSONAS[p.agentId]?.name ?? p.agentId}</strong><br/><small className="muted">{p.agentId}</small></td><td className="mono small">{p.model}</td>
            <td>{p.proposals}</td><td>{p.graded}</td><td>{p.correct}</td>
            <td>{p.hitRate === null ? '—' : <strong className={p.hitRate >= 0.5 ? 'green' : 'red'}>{Math.round(p.hitRate * 100)}%</strong>}</td>
            <td>{p.avgConfidence === null ? '—' : `${(p.avgConfidence * 100).toFixed(0)}%`}</td></tr>)}</tbody></table></div>
        : <p className="empty">No persona votes have expired yet. Every analyst is graded individually — the ensemble is only as good as its members.</p>}
      {confidenceHonesty.correct.length + confidenceHonesty.wrong.length > 0 && <p className="muted small">Confidence honesty: correct calls averaged <strong>{avg(confidenceHonesty.correct) === null ? '—' : `${(avg(confidenceHonesty.correct)! * 100).toFixed(0)}%`}</strong> confidence, wrong calls <strong>{avg(confidenceHonesty.wrong) === null ? '—' : `${(avg(confidenceHonesty.wrong)! * 100).toFixed(0)}%`}</strong>. If those numbers converge, the confidence figure means nothing — and we will say so here.</p>}
    </section>

    <section className="panel">
      <div className="row"><h3>Shadow outcome ledger</h3><span className="badge">{ensembleOutcomes.length} ensemble · {personaOutcomes.length} persona</span></div>
      {ensembleOutcomes.length + personaOutcomes.length
        ? <div className="table-scroll"><table><thead><tr><th>Graded (UTC)</th><th>Source</th><th>Symbol</th><th>Opinion</th><th>Result at expiry</th></tr></thead>
          <tbody>{[...ensembleOutcomes, ...personaOutcomes].sort((a, b) => b.id - a.id).map(o => {
            const wrong = (o.inputs as any)?.grade === 'wrong' || (o.rationale ?? '').includes('direction wrong');
            const move = (o.rationale ?? '').match(/\(([-+][\d.]+)%\)/)?.[1] ?? '';
            return <tr key={o.id}><td className="mono">{o.time.slice(0, 16).replace('T', ' ')}</td>
              <td>{PERSONAS[o.bot_id]?.name ?? o.bot_id}</td><td>{o.symbol}</td>
              <td>{chip(wrong ? 'WRONG' : 'CORRECT', wrong ? 'red' : 'green')}</td>
              <td>{o.rationale} {move && <small className={Number(move) >= 0 ? 'green' : 'red'}>({move}%)</small>}</td></tr>;
          })}</tbody></table></div>
        : <p className="empty">No shadow opinions have expired yet. Every graded call appears here — correct and wrong alike.</p>}
    </section>

    <section className="panel">
      <div className="row"><h3>Thought-process timeline</h3><span className="badge mono">{entries.length} agent events</span></div>
      <p className="muted">Everything the agents said, rejected, or decided — newest first. This is the raw thought process, unedited.</p>
      <div className="table-scroll"><table><thead><tr><th>Time (UTC)</th><th>Source</th><th>Event</th><th>What they said / what happened</th></tr></thead>
        <tbody>{entries.map(e => {
          const who = PERSONAS[e.bot_id]?.name ?? e.bot_id;
          const cls = e.decision === 'agent-proposal' ? 'green' : e.decision === 'agent-reject' ? 'red' : e.decision === 'agent-outcome' ? 'amber' : 'amber';
          return <tr key={e.id} className={e.decision === 'agent-outcome' ? 'outcome-row' : ''}>
            <td className="mono">{e.time.slice(11, 19)}</td>
            <td><strong>{who}</strong><br/><small className="muted">{e.symbol}</small></td>
            <td>{chip(e.decision.replace('agent-', '').toUpperCase(), cls)}</td>
            <td className="thought">{e.rationale}{e.risk_checks?.length ? <><br/><small className="muted">checks: {e.risk_checks.map(c => `${c.check}:${c.pass ? 'pass' : 'FAIL'}`).join(' · ')}</small></> : null}</td>
          </tr>;
        })}</tbody></table></div>
    </section>
  </div>;
}

