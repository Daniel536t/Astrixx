import { describe, expect, it } from 'vitest';
import { describeApprovals } from './Observatory';
import type { ActionProposal } from '../world/types';

function proposal(id: string, status: ActionProposal['status'], actionType: ActionProposal['actionType'] = 'GATHER', target = 'tree-01'): ActionProposal {
  return {
    id, agentId: 'worker-01', actionType, targetEntityId: target,
    parameters: {}, riskLevel: 'LOW', createdAt: 0, status,
  };
}

describe('describeApprovals', () => {
  it('shows only actionable PROPOSED items, capped at four', () => {
    const proposals = [
      proposal('proposal-0001', 'PROPOSED'),
      proposal('proposal-0002', 'PROPOSED'),
      proposal('proposal-0003', 'PROPOSED'),
      proposal('proposal-0004', 'PROPOSED'),
      proposal('proposal-0005', 'PROPOSED'),
      proposal('proposal-0006', 'EXECUTING'),
      proposal('proposal-0007', 'APPROVED'),
    ];
    const { pending, settled } = describeApprovals(proposals);
    expect(pending.map((row) => row.proposalId)).toEqual([
      'proposal-0002', 'proposal-0003', 'proposal-0004', 'proposal-0005',
    ]);
    expect(pending.every((row) => row.riskLevel === 'LOW')).toBe(true);
    expect(settled).toEqual([]);
  });

  it('keeps terminal outcomes visible most-recent-first', () => {
    const proposals = [
      proposal('proposal-0001', 'VERIFIED'),
      proposal('proposal-0002', 'FAILED', 'HARVEST', 'berry-patch-01'),
      proposal('proposal-0003', 'REJECTED', 'BUILD', 'settlement-01'),
      proposal('proposal-0004', 'CANCELLED'),
      proposal('proposal-0005', 'VERIFIED', 'DELIVER', 'settlement-01'),
      proposal('proposal-0006', 'EXECUTING'),
    ];
    const { pending, settled } = describeApprovals(proposals);
    expect(pending).toEqual([]);
    expect(settled.map((row) => `${row.proposalId}:${row.status}`)).toEqual([
      'proposal-0005:VERIFIED',
      'proposal-0004:CANCELLED',
      'proposal-0003:REJECTED',
      'proposal-0002:FAILED',
    ]);
    expect(settled[0]).toMatchObject({ label: 'DELIVER settlement-01' });
  });

  it('labels PLAN proposals with kind, quantity, risk, and plan status', () => {
    const planProposal: ActionProposal = {
      ...proposal('proposal-0009', 'PROPOSED', 'PLAN', 'settlement-01'),
      parameters: { planId: 'plan-01', kind: 'gather-wood', quantity: 2 },
    };
    const { pending } = describeApprovals([planProposal], { 'plan-01': { status: 'active' } });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.label).toBe('PLAN gather-wood ×2 · LOW · active');
    const { pending: unlabeled } = describeApprovals([planProposal]);
    expect(unlabeled[0]!.label).toBe('PLAN gather-wood ×2 · LOW ·');
  });
});
