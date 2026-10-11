/**
 * Model-backed command interpretation for input the deterministic parser
 * cannot handle. The model returns a goal-shaped JSON object that is
 * validated against the same contract as parsed goals; anything invalid
 * becomes a clarification, never a guessed goal.
 */
import type { InferenceProvider } from '../agent/providers/InferenceProvider';

export interface InterpretedGoal {
  kind: 'gather-wood' | 'gather-food' | 'construct-house' | 'construct-farm' | 'construct-shelter' | 'preserve' | 'prioritize' | 'craft';
  quantity: number;
  resource?: 'wood' | 'food';
  recipe?: string;
  blueprint?: string;
  avoid?: Array<'wood' | 'food'>;
  note: string;
}

export interface Interpretation {
  ok: boolean;
  goal?: InterpretedGoal;
  clarify?: string;
  provider: string;
  model: string;
  latencyMs: number;
}

const SCHEMA_HINT = '{"kind": "gather-wood|gather-food|construct-house|construct-farm|construct-shelter|preserve|prioritize|craft", "quantity": <positive int>, "resource": "wood|food (for preserve/prioritize)", "recipe": "stone-axe|carrying-basket (for craft)", "blueprint": "homestead|timber-cabin|thatched-cottage (for construct-house)", "avoid": ["wood|food"] (optional), "note": "<one sentence>"} — or {"clarify": "<question>"} when the request names no world action. No bridges exist (no river). Houses cost 2 wood. Only stone-axe and carrying-basket are craftable. Reply with exactly one JSON object.';

export function validateInterpretedGoal(value: unknown): InterpretedGoal | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['clarify'] === 'string') return null;
  const kinds = ['gather-wood', 'gather-food', 'construct-house', 'construct-farm', 'construct-shelter', 'preserve', 'prioritize', 'craft'];
  if (typeof v['kind'] !== 'string' || !kinds.includes(v['kind'])) return null;
  if (typeof v['quantity'] !== 'number' || !Number.isSafeInteger(v['quantity']) || v['quantity'] < 0 || v['quantity'] > 1000) return null;
  if (v['resource'] !== undefined && v['resource'] !== 'wood' && v['resource'] !== 'food') return null;
  if (v['kind'] === 'craft' && v['recipe'] !== 'stone-axe' && v['recipe'] !== 'carrying-basket') return null;
  if (v['kind'] !== 'craft' && v['recipe'] !== undefined) return null;
  if (v['blueprint'] !== undefined && (v['kind'] !== 'construct-house' || typeof v['blueprint'] !== 'string' || !['homestead', 'timber-cabin', 'thatched-cottage'].includes(v['blueprint']))) return null;
  if (v['avoid'] !== undefined) {
    if (!Array.isArray(v['avoid']) || !(v['avoid'] as unknown[]).every((a) => a === 'wood' || a === 'food')) return null;
  }
  if (typeof v['note'] !== 'string' || v['note'].length === 0) return null;
  return {
    kind: v['kind'] as InterpretedGoal['kind'],
    quantity: v['quantity'] as number,
    resource: v['resource'] as 'wood' | 'food' | undefined,
    recipe: v['recipe'] as string | undefined,
    blueprint: v['blueprint'] as string | undefined,
    avoid: v['avoid'] as Array<'wood' | 'food'> | undefined,
    note: v['note'] as string,
  };
}

export async function interpretCommand(
  provider: InferenceProvider,
  apiKey: string,
  model: string,
  command: string,
  worldSummary: string,
): Promise<Interpretation> {
  const started = Date.now();
  const result = await provider.completeText({
    model,
    apiKey,
    systemPrompt: 'You translate settlement-game commands into strict goal JSON. Never invent buildings, rivers, or mechanics.',
    userPrompt: `World: ${worldSummary}\nCommand: "${command}"\n${SCHEMA_HINT}`,
    maxTokens: 512,
    temperature: 0,
    timeoutMs: 60_000,
    jsonMode: true,
  });
  const fenced = result.text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? result.text).trim();
  try {
    const parsed: unknown = JSON.parse(candidate.slice(candidate.indexOf('{'), candidate.lastIndexOf('}') + 1));
    const goal = validateInterpretedGoal(parsed);
    if (goal) {
      return { ok: true, goal, provider: provider.name, model, latencyMs: result.latencyMs };
    }
    const clarify = (parsed as Record<string, unknown>)?.['clarify'];
    return {
      ok: false,
      clarify: typeof clarify === 'string' && clarify.length > 0 ? clarify : 'That request named no action I can perform in this world.',
      provider: provider.name,
      model,
      latencyMs: Date.now() - started,
    };
  } catch {
    return { ok: false, clarify: 'I could not interpret that command as a world action.', provider: provider.name, model, latencyMs: Date.now() - started };
  }
}
