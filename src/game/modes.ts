/**
 * Control modes as real authority differences.
 *
 * - direct:     the agent loop is OFF; the player issues commands/goals and
 *               every proposal follows the standing LOW-only auto-approval.
 * - delegated:  the agent loop runs with a goal; LOW and MEDIUM auto-approve,
 *               HIGH still holds for a human. Delegation can be revoked.
 * - supervised: the agent loop runs; only LOW auto-approves; MEDIUM and HIGH
 *               hold for explicit approval, and rejections feed back to plan.
 */
import type { RiskLevel } from '../world/types';

export type ControlMode = 'direct' | 'delegated' | 'supervised';

export interface ModePolicy {
  mode: ControlMode;
  agentLoop: boolean;
  autoApproveUpTo: RiskLevel;
  description: string;
}

export function policyFor(mode: ControlMode): ModePolicy {
  switch (mode) {
    case 'direct':
      return { mode, agentLoop: false, autoApproveUpTo: 'LOW', description: 'You command; Moss takes no autonomous turns.' };
    case 'delegated':
      return { mode, agentLoop: true, autoApproveUpTo: 'MEDIUM', description: 'Moss works your goal autonomously; only HIGH-risk work holds for approval.' };
    case 'supervised':
      return { mode, agentLoop: true, autoApproveUpTo: 'LOW', description: 'Moss proposes; MEDIUM and HIGH hold for your explicit approval.' };
  }
}

export function isValidMode(value: string): value is ControlMode {
  return value === 'direct' || value === 'delegated' || value === 'supervised';
}
