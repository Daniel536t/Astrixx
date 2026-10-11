/**
 * Provider registry: which models live behind which provider, and how the
 * active provider/model is selected. Keys stay in environment variables.
 *
 * Selection: ASTRIX_AI_PROVIDER selects the provider; ASTRIX_AI_MODEL
 * selects the model within it (defaults below). Fallback policy: an
 * explicit ordered list ONLY — the runtime never silently swaps providers
 * after a failure; a failed call surfaces as a provider failure unless the
 * operator configured `ASTRIX_AI_FALLBACK` (comma-separated provider names
 * tried in order, each failure recorded).
 */
import { GeminiProvider } from './GeminiProvider';
import { OpenRouterProvider } from './OpenRouterProvider';
import type { InferenceProvider } from './InferenceProvider';

export type ProviderName = 'gemini' | 'openrouter' | 'nim';

export interface ProviderModel {
  provider: ProviderName;
  id: string;
  label: string;
  defaultMaxTokens: number;
  timeoutMs: number;
  /** Free-tier status as last verified; re-check before assuming $0. */
  freeTierNote: string;
}

export const PROVIDER_MODELS: ProviderModel[] = [
  { provider: 'gemini', id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', defaultMaxTokens: 1024, timeoutMs: 60_000, freeTierNote: 'AI Studio free tier assumed for tiny test use; no cost field returned — verify billing before scale use' },
  { provider: 'gemini', id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', defaultMaxTokens: 1024, timeoutMs: 60_000, freeTierNote: 'stable flagship Flash; verify billing before scale use' },
  { provider: 'openrouter', id: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron Super 120B (OR free)', defaultMaxTokens: 1024, timeoutMs: 120_000, freeTierNote: 'verified cost=0 on 2026-10-10; shared pool may 429' },
  { provider: 'openrouter', id: 'poolside/laguna-xs-2.1:free', label: 'Laguna XS 2.1 (OR free)', defaultMaxTokens: 512, timeoutMs: 90_000, freeTierNote: 'free-listed 2026-10-10; upstream 429 observed on shared pool' },
  { provider: 'openrouter', id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', label: 'Nano Omni Reasoning (OR free)', defaultMaxTokens: 1024, timeoutMs: 180_000, freeTierNote: 'free-listed 2026-10-10' },
  { provider: 'openrouter', id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B (OR free)', defaultMaxTokens: 512, timeoutMs: 180_000, freeTierNote: 'free-listed 2026-10-10; 180s timeouts observed' },
];

export const DEFAULT_PROVIDER: ProviderName = 'gemini';
export const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderName, string> = {
  gemini: 'gemini-3.5-flash-lite',
  openrouter: 'nvidia/nemotron-3-super-120b-a12b:free',
  nim: 'nvidia/nemotron-3-super-120b-a12b',
};

export function keyEnvVarFor(provider: ProviderName): string {
  switch (provider) {
    case 'gemini':
      return 'GEMINI_API_KEY';
    case 'openrouter':
      return 'OPENROUTER_API_KEY';
    case 'nim':
      return 'NVIDIA_NIM_API_KEY_B';
  }
}

export function readProviderKey(provider: ProviderName, env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[keyEnvVarFor(provider)];
  return value && value.length > 0 ? value : null;
}

export function lookupProviderModel(provider: ProviderName, id: string): ProviderModel | undefined {
  return PROVIDER_MODELS.find((m) => m.provider === provider && m.id === id);
}

export interface ProviderSelection {
  provider: ProviderName;
  model: string;
  fallback: ProviderName[];
}

export function selectProvider(env: NodeJS.ProcessEnv = process.env): ProviderSelection {
  const raw = (env['ASTRIX_AI_PROVIDER'] ?? DEFAULT_PROVIDER).toLowerCase();
  const provider: ProviderName = raw === 'openrouter' ? 'openrouter' : raw === 'nim' ? 'nim' : 'gemini';
  const model = env['ASTRIX_AI_MODEL'] && env['ASTRIX_AI_MODEL'].length > 0
    ? env['ASTRIX_AI_MODEL']
    : DEFAULT_MODEL_BY_PROVIDER[provider];
  const fallback = (env['ASTRIX_AI_FALLBACK'] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is ProviderName => s === 'gemini' || s === 'openrouter' || s === 'nim')
    .filter((s) => s !== provider);
  return { provider, model, fallback };
}

export function createProvider(name: ProviderName): InferenceProvider {
  switch (name) {
    case 'gemini':
      return new GeminiProvider();
    case 'openrouter':
      return new OpenRouterProvider();
    case 'nim':
      throw new Error('The NIM path uses NimClient, not the generic interface; wire it via NimDecisionProvider.');
  }
}
