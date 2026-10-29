import type { AgentProposal } from './agent-contract';

export type EnsembleResult = {
  direction: 'long' | 'short';
  confidence: number;
  agreeing: string[];
  dissenting: string[];
} | null;

/** The locked ensemble rule (2026-10-28): 2-of-3 agreement with veto. Only a non-flat
 *  direction backed by at least `minAgreement` valid proposals passes; flat/abstain votes
 *  and disagreements starve the quorum. The result is still only a PROPOSAL: the fixed
 *  risk authority and the operator's gates can veto everything downstream, and in shadow
 *  mode nothing executes at all. */
export function ensembleDirection(valid: AgentProposal[], minAgreement = 2): EnsembleResult {
  const groups = new Map<'long' | 'short', AgentProposal[]>();
  for (const p of valid) {
    if (p.direction !== 'long' && p.direction !== 'short') continue;
    groups.set(p.direction, [...(groups.get(p.direction) ?? []), p]);
  }
  for (const [direction, group] of groups) {
    if (group.length >= minAgreement) {
      return {
        direction,
        confidence: group.reduce((sum, p) => sum + p.confidence, 0) / group.length,
        agreeing: group.map(p => p.agentId),
        dissenting: valid.filter(p => !group.includes(p)).map(p => p.agentId),
      };
    }
  }
  return null;
}
