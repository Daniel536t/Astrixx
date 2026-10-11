import './polyfills';
import './style.css';
import { WorldSimulation, workersOf } from './simulation/WorldSimulation';
import { WorldRenderer } from './rendering/WorldRenderer';
import { LocalWorldStateAdapter, MagicBlockDevnetAdapter, type TransactionWallet } from './magicblock/MagicBlockAdapter';
import { FarmDevnetAdapter, type FarmWallet } from './magicblock/FarmChain';
import { FARM_WOOD_COST } from './world/types';
import { mountObservatory, updateObservatory, renderApprovals, renderCommandFeedback, renderGoal, renderMode, renderProvider, renderFarmAuthority } from './ui/Observatory';
import { LocalGathererAgent } from './agent/LocalGathererAgent';
import { ManualAgent } from './agent/ManualAgent';
import { BackendDecisionProvider } from './agent/BackendDecisionProvider';
import { parseCommand, GoalTracker } from './game/goals';
import type { GameGoal } from './game/goals';
import { validateInterpretedGoal } from './game/interpret';
import { e2ePredicates } from './game/e2eStages';
import { resolvePlaceIntent } from './game/placement';
import { nextStep, isGoalRelevant } from './game/planner';
import { policyFor, isValidMode, type ControlMode } from './game/modes';
import { parseStructuredDecision, validateDecisionAgainstWorld } from './agent/nvidia/DecisionSchema';
import { canonicalize, cyrb53 } from './simulation/replay';
import type { ActionType, WorldEvent, WorldState } from './world/types';

declare global {
  interface Window {
    solana?: {
      isPhantom?: boolean;
      publicKey?: { toString(): string };
      connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
      signTransaction(transaction: import('@solana/web3.js').Transaction): Promise<import('@solana/web3.js').Transaction>;
    };
    __ASTRIX_E2E__?: {
      state: WorldState;
      setPaused(value: boolean): void;
      advanceTo(target: string): boolean;
      direct(actionType: string, targetEntityId: string, reason?: string, parameters?: Record<string, unknown>): boolean;
    };
    __ASTRIX_AGENT__?: {
      /** Headless backend model loop. State shown here is the BACKEND run, labelled as such — never merged into the local view silently. */
      runBackend(opts?: { model?: string; maxTurns?: number; goal?: string }): Promise<unknown>;
      lastBackendRun: unknown;
      readonly backendUrl: string;
    };
    __ASTRIX_MAGICBLOCK__?: {
      connectWallet(): Promise<void>;
      initializeTree(): Promise<unknown>;
      delegateTree(): Promise<unknown>;
      proposeTreeChop(): string;
      executeProposal(proposalId: string): Promise<unknown>;
      refreshTree(): Promise<unknown>;
      readonly mode: 'magicblock-er';
    };
    __ASTRIX_FARMCHAIN__?: {
      connectWallet(): Promise<void>;
      initializeFarm(): Promise<unknown>;
      delegateFarm(): Promise<unknown>;
      proposeFarmBuild(): string;
      executeFarmProposal(proposalId: string): Promise<unknown>;
      refreshFarm(): Promise<unknown>;
      commitAndUndelegateFarm(): Promise<unknown>;
      readonly mode: 'magicblock-er';
    };
  }
}

const rootElement = document.querySelector<HTMLElement>('#app');
if (!rootElement) throw new Error('Missing #app application mount.');
const root: HTMLElement = rootElement;

mountObservatory(root, {
  onTogglePause: togglePause,
  onToggleEvents: () => {
    const json = root.querySelector<HTMLElement>('[data-json]');
    if (json) {
      json.hidden = !json.hidden;
      json.textContent = json.hidden ? '' : JSON.stringify({ tick: simulation.state.tick, wood: simulation.state.wood, food: simulation.state.food, water: simulation.state.water, events: simulation.state.events.filter((event) => event.type !== 'AGENT_MOVED').slice(-240), proposals: simulation.state.proposals.slice(-24) }, null, 2);
    }
  },
  onIssueCommand: (text) => void handleCommand(text),
  onSelectMode: (mode) => applyMode(isValidMode(mode) ? mode : 'delegated'),
  onApproveProposal: (proposalId) => {
    const ok = simulation.approveProposal(proposalId);
    renderCommandFeedback(root, ok ? `Approved ${proposalId} — authorized for execution.` : `${proposalId} cannot be approved (already settled or unknown).`);
    renderApprovals(root, simulation.state);
  },
  onRejectProposal: (proposalId) => {
    const ok = simulation.rejectProposal(proposalId);
    renderCommandFeedback(root, ok ? `Rejected ${proposalId} — it will not execute.` : `${proposalId} cannot be rejected (already settled or unknown).`);
    renderApprovals(root, simulation.state);
  },
});

const canvas = root.querySelector<HTMLCanvasElement>('.world-canvas');
if (!canvas) throw new Error('Missing world canvas.');
const simulation = new WorldSimulation();
const renderer = new WorldRenderer(canvas);
// Direct selection: Alt+click (without dragging) drops the picked ground
// point into the command box as explicit coordinates. The point travels the
// normal command path — parsed, resolved, validated, governed.
let pickDown: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (event) => {
  pickDown = { x: event.clientX, y: event.clientY };
});
canvas.addEventListener('pointerup', (event) => {
  const started = pickDown;
  pickDown = null;
  if (!started || !event.altKey) return;
  if (Math.hypot(event.clientX - started.x, event.clientY - started.y) > 6) return;
  const point = renderer.pickGround(event.clientX, event.clientY);
  if (!point) return;
  const input = root.querySelector<HTMLInputElement>('[data-command-input]');
  if (!input) return;
  const suffix = ` at X:${point.x} Z:${point.z}`;
  input.value = input.value.trim() ? `${input.value.trim()}${suffix}` : `build a shelter${suffix}`;
  input.focus();
  renderCommandFeedback(root, `Picked ground X:${point.x} Z:${point.z} — complete the command (e.g. "build a shelter${suffix}") and SEND. The site is validated, never assumed.`);
});
const adapter = new LocalWorldStateAdapter((type, entityId, data) => simulation.recordExternalEvent(type, entityId, data));
void adapter.connect();
const magicBlockConfig = {
  solanaRpcUrl: import.meta.env.VITE_SOLANA_DEVNET_RPC ?? 'https://api.devnet.solana.com',
  magicRouterRpcUrl: 'https://devnet-router.magicblock.app',
  ephemeralRpcUrl: 'https://devnet-eu.magicblock.app',
  programId: import.meta.env.VITE_ASTRIX_PROGRAM_ID ?? 'Gd5DXjcDxr1jJFS2LBzoLkZvYsHZWhVwbYdQ7eZEKSdP',
  treeId: 'tree-01',
};
const farmChainConfig = {
  solanaRpcUrl: magicBlockConfig.solanaRpcUrl,
  magicRouterRpcUrl: magicBlockConfig.magicRouterRpcUrl,
  ephemeralRpcUrl: magicBlockConfig.ephemeralRpcUrl,
  programId: magicBlockConfig.programId,
};
let farmWallet: FarmWallet | null = null;
let farmAdapter: FarmDevnetAdapter | null = null;
window.__ASTRIX_FARMCHAIN__ = {
  mode: 'magicblock-er',
  async connectWallet() {
    if (!window.solana?.connect || !window.solana.signTransaction) throw new Error('Install/connect a compatible Solana wallet (e.g. Phantom) to continue.');
    const connection = await window.solana.connect();
    const publicKey = new (await import('@solana/web3.js')).PublicKey(connection.publicKey.toString());
    farmWallet = {
      publicKey,
      signTransaction: (transaction) => window.solana!.signTransaction!(transaction),
    };
    farmAdapter = new FarmDevnetAdapter(farmChainConfig, farmWallet, (type, entityId, data) => simulation.recordExternalEvent(type, entityId, data));
    await farmAdapter.connect();
    if (modeLabel) modeLabel.textContent = 'MAGICBLOCK DEVNET · HUMAN WALLET REQUIRED';
  },
  async initializeFarm() {
    if (!farmAdapter) throw new Error('Connect a human wallet before initializing devnet farm state.');
    return farmAdapter.initializeFarm();
  },
  async delegateFarm() {
    if (!farmAdapter) throw new Error('Connect a human wallet before delegating farm state.');
    return farmAdapter.delegateFarm();
  },
  proposeFarmBuild() {
    // HIGH-risk, explicitly routed to MagicBlock. Stays PROPOSED until a
    // human approves; local farm-01 work defers while it is live.
    const proposal = simulation.proposeAction('BUILD', 'settlement-01', { structure: 'farm', execution: 'magicblock-er' }, 'HIGH');
    return proposal.id;
  },
  async executeFarmProposal(proposalId) {
    if (!farmAdapter) throw new Error('Connect a human wallet before submitting a MagicBlock action.');
    const proposal = simulation.state.proposals.find((item) => item.id === proposalId);
    if (!proposal || proposal.status !== 'APPROVED' || proposal.parameters['execution'] !== 'magicblock-er') {
      throw new Error('Proposal requires explicit human governance approval before wallet signing.');
    }
    // Governance authorized the action; the human wallet now signs each
    // transaction. Only verified chain evidence mutates local state.
    const result = await farmAdapter.buildFarm(proposal, FARM_WOOD_COST);
    const applied = simulation.applyVerifiedFarmBuild(result.farm.woodSpent, result.signature);
    renderer.sync(simulation.state);
    updateObservatory(root, simulation.state, simulation.state.events.slice(-40), true);
    if (!applied) throw new Error('Chain build verified but local reconciliation refused it; see AUTHORITATIVE_STATE_CONFLICT.');
    return result;
  },
  async refreshFarm() {
    if (!farmAdapter) throw new Error('Connect a human wallet before reading MagicBlock state.');
    return farmAdapter.readFarm();
  },
  async commitAndUndelegateFarm() {
    if (!farmAdapter) throw new Error('Connect a human wallet before undelegating farm state.');
    return farmAdapter.commitAndUndelegateFarm();
  },
};
let wallet: TransactionWallet | null = null;
let magicAdapter: MagicBlockDevnetAdapter | null = null;
const modeLabel = root.querySelector<HTMLElement>('[data-mode]');
if (modeLabel) modeLabel.textContent = 'LOCAL SIMULATION · NOT ONCHAIN';
window.__ASTRIX_MAGICBLOCK__ = {
  mode: 'magicblock-er',
  async connectWallet() {
    if (!window.solana?.connect || !window.solana.signTransaction) throw new Error('Install/connect a compatible Solana wallet (e.g. Phantom) to continue.');
    const connection = await window.solana.connect();
    const publicKey = new (await import('@solana/web3.js')).PublicKey(connection.publicKey.toString());
    wallet = {
      publicKey,
      signTransaction: (transaction) => window.solana!.signTransaction!(transaction),
    };
    magicAdapter = new MagicBlockDevnetAdapter(magicBlockConfig, wallet, (type, entityId, data) => simulation.recordExternalEvent(type, entityId, data));
    await magicAdapter.connect();
    if (modeLabel) modeLabel.textContent = 'MAGICBLOCK DEVNET · HUMAN WALLET REQUIRED';
  },
  async initializeTree() {
    if (!magicAdapter) throw new Error('Connect a human wallet before initializing devnet tree state.');
    return magicAdapter.initializeTree();
  },
  async delegateTree() {
    if (!magicAdapter) throw new Error('Connect a human wallet before delegating tree state.');
    return magicAdapter.delegateWorldState('tree-01');
  },
  proposeTreeChop() {
    const proposal = simulation.proposeAction('GATHER', 'tree-01', { execution: 'magicblock-er' }, 'HIGH');
    return proposal.id;
  },
  async executeProposal(proposalId) {
    if (!magicAdapter) throw new Error('Connect a human wallet before submitting a MagicBlock action.');
    const proposal = simulation.state.proposals.find((item) => item.id === proposalId);
    if (!proposal || proposal.status !== 'APPROVED' || proposal.parameters['execution'] !== 'magicblock-er') throw new Error('Proposal requires explicit human governance approval before wallet signing.');
    const result = await magicAdapter.sendRealtimeAction(proposal);
    simulation.reconcileTreeFromAuthority('tree-01', result.tree.health, true, result.signature);
    renderer.sync(simulation.state);
    updateObservatory(root, simulation.state, simulation.state.events.slice(-40), true);
    return result;
  },
  async refreshTree() {
    if (!magicAdapter) throw new Error('Connect a human wallet before reading MagicBlock state.');
    const tree = await magicAdapter.readRealtimeState('tree-01');
    simulation.reconcileTreeFromAuthority('tree-01', tree.health, true, tree.reference);
    renderer.sync(simulation.state);
    updateObservatory(root, simulation.state, simulation.state.events.slice(-40), paused);
    return tree;
  },
};
const agentBackendUrl = import.meta.env.VITE_ASTRIX_AGENT_BACKEND ?? 'http://127.0.0.1:5193';
const agentBadge = root.querySelector<HTMLElement>('[data-agent-runtime]');
window.__ASTRIX_AGENT__ = {
  lastBackendRun: null,
  backendUrl: agentBackendUrl,
  async runBackend(opts = {}) {
    const response = await fetch(`${agentBackendUrl}/api/agent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: opts.model, maxTurns: opts.maxTurns ?? 6, goal: opts.goal ?? 'wood-food-1' }),
    });
    if (!response.ok) throw new Error(`Agent backend run failed: HTTP ${response.status}`);
    const run = (await response.json()) as { runtime: string; model: string };
    window.__ASTRIX_AGENT__!.lastBackendRun = run;
    // Label only: the backend run is headless and never merged into this view.
    if (agentBadge) agentBadge.textContent = `MODEL · ${run.model.split('/').pop() ?? run.model} · ${run.runtime}`.toUpperCase();
    return run;
  },
};
window.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.repeat || event.target instanceof HTMLButtonElement || event.target instanceof HTMLInputElement) return;
  event.preventDefault();
  togglePause();
});
let paused = false;
let previous = performance.now();
let lastUIRefresh = 0;

if (['localhost', '127.0.0.1'].includes(window.location.hostname) && new URLSearchParams(window.location.search).has('e2e')) {
  window.__ASTRIX_E2E__ = {
    state: simulation.state,
    setPaused(value) {
      paused = value;
      previous = performance.now();
      updateObservatory(root, simulation.state, [], paused);
    },
    direct(actionType, targetEntityId, reason, parameters) {
      // E2E-only player control: queues a directive through the same governed
      // path as UI-issued directives (proposals, approval, verification all
      // apply). Used to drive actions with no command mapping, like REST.
      simulation.issueDirective(
        { actionType: actionType as ActionType, targetEntityId, reason: reason ?? 'e2e-direct', parameters: parameters ?? {} },
        undefined,
        undefined,
      );
      return true;
    },
    advanceTo(target) {
      paused = true;
      unsubscribeWorld();
      // E2E harness only: the shipped world boots idle (no ambient loop), so
      // headless stage advances temporarily run the baseline gatherer, then
      // restore idle. Product boot behavior is unchanged.
      simulation.setAgent(baselineAgent);
      const predicate = (e2ePredicates as Record<string, (state: Readonly<WorldState>) => boolean>)[target];
      let reached = false;
      if (predicate) reached = simulation.advanceUntil(predicate, 3600);
      simulation.setAgent(manualAgent);
      if (!reached) {
        unsubscribeWorld = simulation.subscribe(syncWorld);
        return false;
      }
      renderer.sync(simulation.state);
      renderer.updatePresentation(simulation.state);
      updateObservatory(root, simulation.state, simulation.state.events.slice(-240), true);
      unsubscribeWorld = simulation.subscribe(syncWorld);
      previous = performance.now();
      return true;
    },
  };
}

function togglePause(): void {
  paused = !paused;
  previous = performance.now();
  updateObservatory(root, simulation.state, [], paused);
}

// ---- Game controller: modes, goals, commands, model/planner decisions ----

let controlMode: ControlMode = 'delegated';
const goalTracker = new GoalTracker();
/** Browser-side goal → plan mapping. Mirrors the headless runner: one governed plan per goal. */
const planByGoal = new Map<string, string>();
const baselineAgent = new LocalGathererAgent();
const manualAgent = new ManualAgent();
const backendDecider = new BackendDecisionProvider(agentBackendUrl);
let modelArmed = false;
let deciding = false;
// Bounded model primacy: the model leads while usable; after consecutive
// unusable model turns the labelled planner takes over for this goal so
// gameplay never stalls on inference. Resets on success, new goal, or mode.
let modelMisses = 0;
const MODEL_MISS_LIMIT = 3;

function describeGoalText(goal: { kind: string; quantity: number; resource?: string; recipe?: string }): string {
  switch (goal.kind) {
    case 'construct-house':
      return `BUILD ${goal.quantity} HOUSE`;
    case 'construct-shelter':
      return `BUILD ${goal.quantity} SHELTER`;
    case 'gather-wood':
      return `GATHER ${goal.quantity} WOOD`;
    case 'gather-food':
      return `GATHER ${goal.quantity} FOOD`;
    case 'craft':
      return `CRAFT ${(goal.recipe ?? 'item').toUpperCase().replace('-', ' ')}`;
    case 'preserve':
      return `HOLD ${goal.resource} ≥ ${goal.quantity}`;
    case 'prioritize':
      return `PRIORITIZE ${goal.resource}`;
    default:
      return String(goal.kind).toUpperCase();
  }
}

function statusSummary(): string {
  const houses = Object.values(simulation.state.entities).filter((e) => e.kind === 'house' && e.state === 'complete').length;
  const farms = Object.values(simulation.state.entities).filter((e) => e.kind === 'farm');
  const readyFarms = farms.filter((e) => e.kind === 'farm' && e.state === 'ready').length;
  const population = workersOf(simulation.state).length;
  return `Wood ${simulation.state.wood} · Food ${simulation.state.food} · Water ${simulation.state.water} · Houses ${houses} · Farms ${farms.length} (${readyFarms} ready) · Population ${population} · Mode ${controlMode.toUpperCase()} · ${goalTracker.active ? describeGoalText(goalTracker.active) : 'no active goal'}`;
}

function applyMode(mode: ControlMode): void {
  controlMode = mode;
  modelMisses = 0;
  const policy = policyFor(mode);
  simulation.autoApproveUpTo = policy.autoApproveUpTo;
  // Wilderness: no ambient work loop. Without an explicit goal the
  // inhabitant stands by (ManualAgent); the baseline gatherer only runs
  // inside headed tests / explicit delegation, never on page load.
  simulation.setAgent(goalTracker.active ? manualAgent : manualAgent);
  renderMode(root, mode);
  const badge = root.querySelector<HTMLElement>('[data-agent-runtime]');
  if (badge && !goalTracker.active) badge.textContent = 'LOCAL POLICY';
  renderCommandFeedback(root, `Mode ${mode.toUpperCase()}: ${policy.description}`);
  void maybeDecide();
}

/** Resolve a parsed goal's placement intent against live state. */
function resolveGoalSite(goal: Omit<GameGoal, 'id' | 'status' | 'createdAt'>): { ok: true; goal: Omit<GameGoal, 'id' | 'status' | 'createdAt'> } | { ok: false; clarify: string } {
  if (!goal.place || goal.place.kind === 'auto') {
    const { place: _dropped, ...rest } = goal;
    return { ok: true, goal: rest };
  }
  const worker = simulation.state.entities['worker-01'];
  const from = worker && 'position' in worker ? worker.position : { x: 0, z: 0 };
  const resolved = resolvePlaceIntent(simulation.state, goal.place, from);
  if (!resolved.ok) {
    if (resolved.clarify === '__AUTO__') {
      const { place: _dropped, ...rest } = goal;
      return { ok: true, goal: rest };
    }
    return { ok: false, clarify: resolved.clarify };
  }
  const { place: _dropped, ...rest } = goal;
  const exact = goal.place?.kind === 'exact';
  return { ok: true, goal: { ...rest, site: { x: resolved.x, z: resolved.z }, siteNote: resolved.description, ...(exact ? { exactSite: true as const } : {}) } };
}

async function handleCommand(text: string): Promise<void> {
  const parsed = parseCommand(text);
  if (parsed.ok) {
    if (parsed.goal.note === '__CANCEL__') {
      const cancelled = goalTracker.cancel();
      if (cancelled) {
        const cancelledPlan = planByGoal.get(cancelled.id);
        if (cancelledPlan) {
          simulation.cancelPlan(cancelledPlan);
          planByGoal.delete(cancelled.id);
        }
      }
      simulation.clearDirectives();
      simulation.setAgent(manualAgent);
      renderGoal(root, 'GOAL · NONE');
      renderCommandFeedback(root, cancelled ? `Goal revoked (${describeGoalText(cancelled)}). Delegation stopped; inhabitant standing by.` : 'No active goal to revoke.');
      return;
    }
    // Placement intents resolve against authoritative state NOW, so the
    // goal carries exact coordinates plus their derivation. Execution
    // re-validates; an invalid site fails loudly, never silently relocates.
    const withSite = resolveGoalSite(parsed.goal);
    if (!withSite.ok) {
      renderCommandFeedback(root, withSite.clarify);
      renderGoal(root, 'GOAL · NONE');
      return;
    }
    const goal = goalTracker.setGoal({ ...withSite.goal }, simulation.state.tick);
    modelMisses = 0;
    simulation.setAgent(manualAgent);
    renderGoal(root, `GOAL · ${describeGoalText(goal)} · ACTIVE · VIA COMMAND`);
    renderCommandFeedback(root, `Goal set: ${describeGoalText(goal)}. ${withSite.goal.note}`);
    void maybeDecide();
    return;
  }
  if (parsed.clarify === '__STATUS__') {
    renderCommandFeedback(root, statusSummary());
    return;
  }
  if (parsed.gap) {
    // Capability gaps are audit-trail facts, not dead ends: journal the
    // missing capability so future development can find every request.
    simulation.recordJournal({ turn: 0, source: 'command', goal: null, candidates: [], verdict: `missing-capability:${parsed.gap}`, chosen: null });
  }
  // Deterministic clarifications that state world facts (no river, status,
  // capabilities) are authoritative — show them directly. Only genuinely
  // unrecognized input goes to the model, and only when inference is armed.
  const unknown = parsed.clarify.startsWith('I did not understand');
  if (!unknown || !modelArmed) {
    renderCommandFeedback(root, unknown ? `${parsed.clarify} (Model interpretation offline — deterministic commands only.)` : parsed.clarify);
    return;
  }
  renderCommandFeedback(root, 'Interpreting with the model…');
  try {
    const response = await fetch(`${agentBackendUrl}/api/interpret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, useModel: true }),
    });
    const data = (await response.json()) as {
      interpretation?: { ok?: boolean; goal?: { kind: 'gather-wood' | 'gather-food' | 'construct-house' | 'construct-shelter' | 'craft' | 'preserve' | 'prioritize'; quantity: number; resource?: 'wood' | 'food'; recipe?: string; blueprint?: string; avoid?: Array<'wood' | 'food'>; note: string }; clarify?: string };
    };
    const interpretation = data.interpretation;
    if (interpretation?.ok && interpretation.goal) {
      const validated = validateInterpretedGoal({ ...interpretation.goal, note: interpretation.goal.note || 'model goal' });
      if (!validated) {
        renderCommandFeedback(root, interpretation?.clarify ?? 'The model proposed a goal outside the supported contract; nothing was set.');
        return;
      }
      const goal = goalTracker.setGoal({ ...validated }, simulation.state.tick);
      modelMisses = 0;
      simulation.setAgent(manualAgent);
      renderGoal(root, `GOAL · ${describeGoalText(goal)} · ACTIVE · VIA MODEL`);
      renderCommandFeedback(root, `Goal set by model: ${describeGoalText(goal)}. ${validated.note}`);
      void maybeDecide();
    } else {
      renderCommandFeedback(root, interpretation?.clarify ?? parsed.clarify);
    }
  } catch {
    renderCommandFeedback(root, `${parsed.clarify} (Model interpretation failed; deterministic commands only.)`);
  }
}

async function maybeDecide(): Promise<void> {
  if (deciding || paused) return;
  const goal = goalTracker.active;
  if (!goal || simulation.directives.length > 0) return;
  const worker = simulation.state.entities['worker-01'];
  // Re-issue while idle OR moving: directives are consumed one per step, so
  // sustained movement needs a fresh directive each frame. Sustained
  // activities (chopping/gathering/building/carrying) must NOT be disturbed —
  // re-running their start branch would reset progress or double-spend.
  // Any free worker unblocks the next directive; crowded moments wait.
  const anyFree = workersOf(simulation.state).some((w) => w.activity === 'idle' || w.activity === 'moving');
  if (!worker || worker.kind !== 'worker' || !anyFree) return;
  deciding = true;
  try {
    const obs = baselineAgent.observe(simulation.state);
    let step = null as null | { actionType: ActionType; targetEntityId: string; reason: string; parameters?: Record<string, unknown> };
    let source: 'model' | 'planner' = 'planner';
    const modelUsable = controlMode !== 'direct' && modelArmed && modelMisses < MODEL_MISS_LIMIT;
    // Browser decision provenance (Phase 5.2): bind each model request to
    // its observation context in the input log, including fallbacks, so the
    // audit trail shows what the model said (or why it didn't drive).
    const observationDigest = cyrb53(canonicalize(obs));
    if (modelUsable) {
      try {
        const result = await backendDecider.requestDecision(obs, describeGoalText(goal), []);
        const parsed = parseStructuredDecision(result.rawText);
        const verdict = parsed ? validateDecisionAgainstWorld(parsed, simulation.state) : null;
        const relevant = parsed?.action ? isGoalRelevant(goal, obs, parsed.action) : false;
        if (parsed?.action && verdict?.ok && relevant) {
          step = { actionType: parsed.action.actionType, targetEntityId: parsed.action.targetEntityId, reason: `model:${result.model} :: ${parsed.intent}`, parameters: parsed.action.parameters ?? {} };
          source = 'model';
          modelMisses = 0;
          simulation.recordInput('modelDecision', {
            driver: 'browser', goal: goal.id, observationDigest, model: result.model,
            rawText: result.rawText, outcome: 'decision', intent: parsed.intent,
            decision: { actionType: step.actionType, targetEntityId: step.targetEntityId, reason: step.reason, parameters: step.parameters ?? {} },
          });
        } else {
          modelMisses += 1;
          const why = !parsed ? 'not-json' : verdict && !verdict.ok ? verdict.reason : 'off-goal';
          simulation.recordInput('modelDecision', {
            driver: 'browser', goal: goal.id, observationDigest, model: result.model,
            rawText: result.rawText, outcome: 'fallback-planner', reason: why,
          });
          renderCommandFeedback(root, `Model decision unusable (${why}); planner stepping in — labelled as planner, not model.`);
        }
      } catch {
        modelMisses += 1;
        simulation.recordInput('modelDecision', {
          driver: 'browser', goal: goal.id, observationDigest, model: 'unknown',
          rawText: null, outcome: 'fallback-planner', reason: 'provider-error',
        });
        renderCommandFeedback(root, 'Model unavailable mid-loop; planner stepping in — labelled as planner, not model.');
      }
    } else if (controlMode !== 'direct' && modelArmed && modelMisses >= MODEL_MISS_LIMIT) {
      renderCommandFeedback(root, 'Model missed repeatedly; planner driving this goal — labelled as planner, not model.');
    }
    step ??= nextStep(goal, obs);
    if (!step) return;
    const check = validateDecisionAgainstWorld(
      { action: { actionType: step.actionType, targetEntityId: step.targetEntityId, parameters: step.parameters ?? {} }, intent: 'goal-step', expectation: 'goal progress' },
      simulation.state,
    );
    if (!check.ok) {
      renderCommandFeedback(root, `Step blocked by validation (${check.reason}): ${check.detail}`);
      return;
    }
    if (!isGoalRelevant(goal, obs, { actionType: step.actionType, targetEntityId: step.targetEntityId })) {
      renderCommandFeedback(root, 'Step legal but off-goal; holding for a relevant step.');
      return;
    }
    if (goal.kind === 'craft' && step.actionType === 'CRAFT' && (step.parameters?.['recipe'] ?? null) !== (goal.recipe ?? null)) {
      renderCommandFeedback(root, 'Step legal but off-goal: wrong recipe for this goal.');
      return;
    }
    // One governed plan per goal: routine steps execute as virtual plan
    // steps, never as per-step proposals. DELIVER is automatic — a carrying
    // worker delivers via the carrying branch, so no directive is needed.
    if (step.actionType === 'DELIVER') return;
    let plan = planByGoal.get(goal.id) ? simulation.state.plans[planByGoal.get(goal.id)!] : undefined;
    if (!plan) {
      const submitted = simulation.submitPlan(goal.kind, goal.quantity, goal.resource, goal.blueprint);
      plan = submitted.plan;
      planByGoal.set(goal.id, plan.id);
    }
    const proposal = plan.proposalId ? simulation.state.proposals.find((p) => p.id === plan.proposalId) : undefined;
    if (plan.status === 'rejected' || plan.status === 'cancelled' || plan.status === 'expired'
      || proposal?.status === 'REJECTED' || proposal?.status === 'CANCELLED') {
      planByGoal.delete(goal.id);
      renderCommandFeedback(root, `Plan ${plan.id} ${plan.status}: no steps executed; replanning on the next turn.`);
      return;
    }
    if (plan.status !== 'active') {
      renderCommandFeedback(root, `Plan ${plan.id} awaiting approval; routine steps hold until governance releases it.`);
      return;
    }
    simulation.issueDirective({ actionType: step.actionType, targetEntityId: step.targetEntityId, reason: `${source}: ${step.reason}`, parameters: step.parameters ?? {} }, undefined, plan.id);
    const badge = root.querySelector<HTMLElement>('[data-agent-runtime]');
    if (badge) badge.textContent = source === 'model' ? 'MODEL DRIVEN' : 'PLANNER DRIVEN';
  } finally {
    deciding = false;
  }
}

async function checkBackendInference(): Promise<void> {
  try {
    const response = await fetch(`${agentBackendUrl}/api/health`);
    const data = (await response.json()) as { inference?: { provider?: string; model?: string; credentialConfigured?: boolean } };
    const inference = data.inference;
    modelArmed = Boolean(inference?.credentialConfigured);
    renderProvider(root, modelArmed ? `PROVIDER · ${String(inference?.provider).toUpperCase()} ${inference?.model}` : 'PROVIDER · OFFLINE · LOCAL ONLY');
    if (!modelArmed) {
      const badge = root.querySelector<HTMLElement>('[data-agent-runtime]');
      if (badge && !goalTracker.active) badge.textContent = 'LOCAL POLICY';
    }
  } catch {
    modelArmed = false;
    renderProvider(root, 'PROVIDER · OFFLINE · LOCAL ONLY');
  }
}
void checkBackendInference();
renderMode(root, controlMode);
applyMode('delegated');
// Timer-driven directive pump: the event subscription goes quiet when the
// worker idles with no proposals, so goal progress must not depend on it.
setInterval(() => { void maybeDecide(); }, 1000);

// ---- Delegated farm authority: ER reads govern construction truth ----
interface FarmStateResponse {
  ok?: boolean;
  delegated?: boolean;
  exists?: boolean;
  farm?: { state?: string; nonce?: number; woodSpent?: number; authority?: string };
  slot?: number | null;
  error?: string;
}

async function refreshFarmAuthority(): Promise<void> {
  let data: FarmStateResponse | null = null;
  try {
    const response = await fetch(`${agentBackendUrl}/api/farm/state`);
    data = (await response.json()) as FarmStateResponse;
  } catch {
    data = null;
  }
  if (!data || data.ok !== true) {
    // Read failed or timed out: mark stale, keep last verified display.
    // Never substitute a local value and call it authoritative.
    simulation.markLeaseStale('farm-01');
    const lease = simulation.state.leases['farm-01'];
    renderFarmAuthority(root, lease && lease.lastVerifiedSlot !== null
      ? `FARM · STALE (LAST SLOT ${lease.lastVerifiedSlot})`
      : 'FARM · UNREACHABLE');
    return;
  }
  if (!data.exists || !data.farm) {
    renderFarmAuthority(root, 'FARM · LOCAL-ONLY');
    return;
  }
  const outcome = simulation.reconcileFarmLease(
    { state: data.farm.state === 'built' ? 'built' : 'unbuilt', nonce: data.farm.nonce ?? 0, woodSpent: data.farm.woodSpent ?? 0, authority: data.farm.authority ?? '' },
    data.slot ?? null,
  );
  const lease = simulation.state.leases['farm-01'];
  if (outcome === 'conflict-held') {
    renderFarmAuthority(root, 'FARM · CONFLICT (HELD FOR REVIEW)');
  } else if (lease) {
    renderFarmAuthority(root, `FARM · ER-${data.farm.state?.toUpperCase()} #${data.farm.nonce} · SLOT ${data.slot ?? '?'}`);
  } else {
    renderFarmAuthority(root, 'FARM · LOCAL-ONLY');
  }
}
void refreshFarmAuthority();
setInterval(() => { void refreshFarmAuthority(); }, 30000);

const syncWorld = (state: WorldState, latest: WorldEvent[]) => {
  renderer.sync(state);
  updateObservatory(root, state, latest, paused);
  const completed = goalTracker.update(state);
  if (completed) {
    renderCommandFeedback(root, `Goal complete: ${describeGoalText(completed)}. Inhabitant standing by.`);
    const donePlan = planByGoal.get(completed.id);
    if (donePlan) {
      simulation.completePlan(donePlan);
      planByGoal.delete(completed.id);
    }
    simulation.clearDirectives();
    simulation.setAgent(manualAgent);
  }
  renderGoal(root, goalTracker.active ? `GOAL · ${describeGoalText(goalTracker.active)} · ACTIVE` : 'GOAL · NONE');
  renderApprovals(root, state);
  void maybeDecide();
};
let unsubscribeWorld = simulation.subscribe(syncWorld);
renderer.sync(simulation.state);
updateObservatory(root, simulation.state, simulation.state.events, paused);

function frame(now: number): void {
  requestAnimationFrame(frame);
  // Cap per-frame sim time high enough to stay near real-time on slow
  // software renderers (~2fps); on 60fps displays frames are ~16ms anyway.
  const elapsed = Math.min((now - previous) / 1000, 0.5);
  previous = now;
  if (!paused) {
    simulation.tick(elapsed);
    if (now - lastUIRefresh > 500) {
      updateObservatory(root, simulation.state, simulation.state.events.filter((event) => event.type !== 'AGENT_MOVED').slice(-12), paused);
      lastUIRefresh = now;
    }
    // Cosmetics freeze with the sim: a paused world must not walk, chop,
    // smoke, or shimmer. Presentation reads ticks, never wall-clock.
    renderer.updatePresentation(simulation.state);
  }
}
requestAnimationFrame(frame);

window.addEventListener('beforeunload', () => {
  renderer.dispose();
  adapter.disconnect();
});
