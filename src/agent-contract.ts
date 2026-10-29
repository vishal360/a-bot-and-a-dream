import type { Store } from './store';

/** Agent proposal contracts (docs/AGENT_SETUP.md, build order step 2).
 *  Agents are PROPOSAL SOURCES: a contract is a typed, expiring direction opinion with a
 *  confidence and a rationale. It never sizes orders, never touches the executor and
 *  carries no authority: the 2-of-3 ensemble, the fixed risk checks and the operator's
 *  gates decide everything downstream. Fail-closed validation; the runtime owns identity
 *  and timestamps (the model never gets to claim an id, a symbol or a clock). */

export type AgentDirection = 'long' | 'short' | 'flat';

export type AgentProposal = {
  version: 1;
  id: string;
  agentId: string;
  symbol: string;
  direction: AgentDirection;
  confidence: number;
  horizonSeconds: number;
  rationale: string;
  createdAt: string;
  expiresAt: string;
};

const AGENT_ID = /^agent-[a-z0-9-]{3,40}$/;
const SYMBOL = /^[A-Za-z0-9._/-]{1,80}$/;
const ID = /^[a-zA-Z0-9-]{8,80}$/;

/** Validate the model-supplied fields of a proposal. Throws with a specific reason. */
export function validateProposalFields(raw: {
  direction?: unknown; confidence?: unknown; horizonSeconds?: unknown; rationale?: unknown;
}): { direction: AgentDirection; confidence: number; horizonSeconds: number; rationale: string } {
  const direction = raw.direction;
  if (direction !== 'long' && direction !== 'short' && direction !== 'flat') throw new Error('direction must be long|short|flat');
  const confidence = raw.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('confidence must be 0..1');
  const horizonSeconds = raw.horizonSeconds;
  if (typeof horizonSeconds !== 'number' || !Number.isInteger(horizonSeconds) || horizonSeconds < 60 || horizonSeconds > 3600) throw new Error('horizonSeconds must be 60..3600');
  const rationale = raw.rationale;
  if (typeof rationale !== 'string' || rationale.trim().length < 1 || rationale.length > 300) throw new Error('rationale must be 1..300 chars');
  return { direction, confidence, horizonSeconds, rationale };
}

/** Build a full contract from validated fields plus runtime-owned identity.
 *  expiresAt is DERIVED from createdAt + horizonSeconds — the model cannot extend its own life. */
export function buildProposal(
  fields: { direction: AgentDirection; confidence: number; horizonSeconds: number; rationale: string },
  identity: { id: string; agentId: string; symbol: string },
  nowMs: number,
): AgentProposal {
  if (!ID.test(identity.id)) throw new Error('Invalid proposal id');
  if (!AGENT_ID.test(identity.agentId)) throw new Error(`Invalid agent id: ${identity.agentId}`);
  if (!SYMBOL.test(identity.symbol)) throw new Error(`Invalid symbol: ${identity.symbol}`);
  const createdAt = new Date(nowMs).toISOString();
  return {
    version: 1, id: identity.id, agentId: identity.agentId, symbol: identity.symbol,
    direction: fields.direction, confidence: fields.confidence, horizonSeconds: fields.horizonSeconds,
    rationale: fields.rationale, createdAt, expiresAt: new Date(nowMs + fields.horizonSeconds * 1000).toISOString(),
  };
}

/** Stale proposals auto-reject: an expired contract is dead on arrival. */
export function proposalExpired(proposal: AgentProposal, nowMs: number): boolean {
  return Date.parse(proposal.expiresAt) <= nowMs;
}

/** Re-validate a stored contract (defense against corrupted persistence). */
export function validateStoredProposal(raw: unknown): AgentProposal {
  const p = raw as AgentProposal;
  if (!p || typeof p !== 'object') throw new Error('proposal is not an object');
  if (p.version !== 1) throw new Error('unsupported proposal version');
  if (!ID.test(String(p.id))) throw new Error('invalid proposal id');
  if (!AGENT_ID.test(String(p.agentId))) throw new Error('invalid agent id');
  if (!SYMBOL.test(String(p.symbol))) throw new Error('invalid symbol');
  if (p.direction !== 'long' && p.direction !== 'short' && p.direction !== 'flat') throw new Error('invalid direction');
  if (typeof p.confidence !== 'number' || !Number.isFinite(p.confidence) || p.confidence < 0 || p.confidence > 1) throw new Error('invalid confidence');
  if (!Number.isInteger(p.horizonSeconds) || p.horizonSeconds < 60 || p.horizonSeconds > 3600) throw new Error('invalid horizon');
  if (typeof p.rationale !== 'string' || !p.rationale.length) throw new Error('invalid rationale');
  if (!Date.parse(p.createdAt) || !Date.parse(p.expiresAt)) throw new Error('invalid timestamps');
  return p;
}
