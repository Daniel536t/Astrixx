/**
 * Configurable registry of the NVIDIA NIM candidate models supplied for ASTrix.
 *
 * Each entry records which credential slot (A or B) the model was originally
 * associated with. Availability is proven only by a real completion call, not
 * by the provider's catalog listing (which advertises the same catalog for
 * both keys). Do not silently retry a failed request with the other key.
 */
export type CredentialSlot = 'A' | 'B';

export interface RegistryModel {
  /** Exact upstream model identifier sent to the NIM API. */
  id: string;
  /** Credential slot this model was originally associated with. */
  keySlot: CredentialSlot;
  /** Short human label for logs and the Observatory. */
  label: string;
  /** Whether the model emits reasoning traces / needs a larger token budget. */
  reasoning: boolean;
  /** Default max_tokens for decision turns. */
  defaultMaxTokens: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
}

export const NVIDIA_NIM_BASE_URL = 'https://integrate.api.nvidia.com/v1';

export const MODEL_REGISTRY: RegistryModel[] = [
  { id: 'meta/muse-glimmer-30b', keySlot: 'A', label: 'Muse Glimmer 30B', reasoning: true, defaultMaxTokens: 1024, timeoutMs: 120_000 },
  { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', keySlot: 'A', label: 'Nemotron Lightning 30B', reasoning: false, defaultMaxTokens: 512, timeoutMs: 120_000 },
  { id: 'poolside/laguna-xs-2.1', keySlot: 'A', label: 'Laguna XS 2.1', reasoning: false, defaultMaxTokens: 512, timeoutMs: 60_000 },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b', keySlot: 'A', label: 'Nemotron Ultra 550B', reasoning: true, defaultMaxTokens: 1024, timeoutMs: 120_000 },
  { id: 'z-ai/glm-5.3', keySlot: 'B', label: 'GLM 5.3', reasoning: true, defaultMaxTokens: 1024, timeoutMs: 120_000 },
  { id: 'z-ai/glm-5.3-flash', keySlot: 'B', label: 'GLM 5.3 Flash', reasoning: true, defaultMaxTokens: 1024, timeoutMs: 180_000 },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', keySlot: 'B', label: 'Nemotron Nano Omni Reasoning', reasoning: true, defaultMaxTokens: 1024, timeoutMs: 180_000 },
  { id: 'google/gemma-4-31b-it', keySlot: 'B', label: 'Gemma 4 31B IT', reasoning: false, defaultMaxTokens: 512, timeoutMs: 180_000 },
  { id: 'nvidia/nemotron-3-super-120b-a12b', keySlot: 'B', label: 'Nemotron Super 120B', reasoning: true, defaultMaxTokens: 1024, timeoutMs: 120_000 },
];

export function registryLookup(id: string): RegistryModel | undefined {
  return MODEL_REGISTRY.find((model) => model.id === id);
}

/** Environment variable holding the API key for a credential slot. Never logged. */
export function keyEnvVar(slot: CredentialSlot): 'NVIDIA_NIM_API_KEY_A' | 'NVIDIA_NIM_API_KEY_B' {
  return slot === 'A' ? 'NVIDIA_NIM_API_KEY_A' : 'NVIDIA_NIM_API_KEY_B';
}

export function readCredential(slot: CredentialSlot, env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[keyEnvVar(slot)];
  return value && value.length > 0 ? value : null;
}
