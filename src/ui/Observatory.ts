import type { ActionProposal, WorldEvent, WorldState } from '../world/types';

const labels: Record<string, string> = {
  WORLD_INITIALIZED: 'World initialized',
  INTEGRATION_MODE_SELECTED: 'Integration mode selected',
  GOVERNANCE_PERMISSION_GRANTED: 'Governance permission granted',
  GOVERNANCE_PERMISSION_DENIED: 'Governance permission denied',
  WORLD_STATE_DELEGATED: 'World state delegated',
  TRANSACTION_AUTHORIZED: 'Transaction authorized',
  TRANSACTION_SUBMITTED: 'Transaction submitted',
  TRANSACTION_CONFIRMED: 'Transaction confirmed',
  WORLD_STATE_COMMITTED: 'World state committed',
  WORLD_STATE_UNDELEGATED: 'World state undelegated',
  AUTHORITATIVE_STATE_VERIFIED: 'Authoritative state verified',
  LOCAL_STATE_RECONCILED: 'Local state reconciled',
  AUTHORITATIVE_STATE_CONFLICT: 'Authoritative state conflict',
  CHAIN_OPERATION_FAILED: 'Chain operation failed',
  ENTITY_SPAWNED: 'Entity spawned',
  AGENT_MOVED: 'Worker moved',
  AGENT_OBSERVED: 'Agent observed world',
  AGENT_DECIDED: 'Agent chose action',
  RESOURCE_TARGETED: 'Resource selected',
  GATHER_ACTION_STARTED: 'Gathering started',
  TREE_DAMAGED: 'Tree damaged',
  TREE_CHOPPED: 'Tree chopped',
  TREE_PLANTED: 'Sapling planted',
  TREE_MATURED: 'Sapling matured',
  BERRY_PATCH_HARVESTED: 'Berries gathered',
  WATER_DRAWN: 'Water drawn',
  WATER_LOW: 'Water running low',
  POPULATION_THIRSTY: 'Settlement thirsty',
  RESOURCE_CREATED: 'Resource created',
  RESOURCE_PICKED_UP: 'Resource picked up',
  RESOURCE_DELIVERED: 'Resource delivered',
  RESOURCE_ADDED: 'Resource added',
  MATERIAL_COLLECTED: 'Material collected',
  CRAFTING_STARTED: 'Crafting started',
  CRAFTING_COMPLETED: 'Crafting completed',
  CRAFTING_FAILED: 'Crafting failed',
  CONSTRUCTION_STARTED: 'Construction started',
  CONSTRUCTION_COMPLETED: 'Construction completed',
  CONSTRUCTION_FAILED: 'Construction failed',
  CONSTRUCTION_STAGE: 'Construction stage',
  REST_COMPLETED: 'Rested at shelter',
  FARM_HARVESTED: 'Farm harvested',
  FOOD_CONSUMED: 'Food consumed',
  FOOD_LOW: 'Food running low',
  POPULATION_HUNGRY: 'Settlement hungry',
  POPULATION_JOINED: 'Newcomer joined',
  MAGICBLOCK_DELEGATION_REQUESTED: 'Chain delegation requested',
  MAGICBLOCK_DELEGATION_CONFIRMED: 'Chain delegation confirmed',
  MAGICBLOCK_EXECUTION_SUBMITTED: 'Chain execution submitted',
  MAGICBLOCK_EXECUTION_CONFIRMED: 'Chain execution confirmed',
  MAGICBLOCK_STATE_VERIFIED: 'Chain state verified',
  MAGICBLOCK_COMMIT_REQUESTED: 'Chain commit requested',
  MAGICBLOCK_COMMIT_CONFIRMED: 'Chain commit confirmed',
  MAGICBLOCK_BASE_STATE_VERIFIED: 'Base state verified',
  MAGICBLOCK_OPERATION_FAILED: 'Chain operation failed',
  ACTION_PROPOSED: 'Action proposed',
  ACTION_STATUS_CHANGED: 'Proposal status',
  PLAN_STATUS_CHANGED: 'Plan status',
};

export interface ObservatoryControls {
  onTogglePause(): void;
  onToggleEvents(): void;
  onIssueCommand(text: string): void;
  onSelectMode(mode: string): void;
  onApproveProposal(proposalId: string): void;
  onRejectProposal(proposalId: string): void;
}

export function mountObservatory(root: HTMLElement, controls: ObservatoryControls): void {
  root.innerHTML = `
    <main class="app-shell">
      <section class="world-panel" aria-label="Playable forest world">
        <canvas class="world-canvas" aria-label="Stylized forest clearing with autonomous worker"></canvas>
        <div class="world-grain" aria-hidden="true"></div>
        <header class="topbar">
          <a class="wordmark" href="#" aria-label="ASTrix home"><span class="wordmark-mark">A</span> ASTrix <span class="wordmark-divider">/</span> <span class="world-title">THE LIVING CLEARING</span></a>
          <div class="world-live"><span class="live-dot"></span> <span class="chain-label">LOCAL SIMULATION</span></div>
        </header>
        <div class="wood-card">
          <div class="resource-glyph">⌁</div>
          <div class="stockpile-values"><div><div class="resource-caption">SETTLEMENT STOCKPILE</div><div class="wood-value"><span data-wood>0</span><span class="wood-unit"> WOOD</span></div></div><div class="food-value"><span data-food>00</span><span class="wood-unit"> FOOD</span></div><div class="food-value"><span data-water>00</span><span class="wood-unit"> WATER</span></div></div>
          <div class="resource-target"><span class="resource-target-fill"></span></div>
        </div>
        <div class="settlement-line" aria-live="polite"><span data-settlement>POP 03 · HOMES 00 · FARMS 00</span><span class="farm-authority" data-farm>FARM · LOCAL-ONLY</span></div>
        <div class="world-note"><span class="note-dot"></span> <span data-world-status>Worker is observing the clearing…</span></div>
        <div class="world-caption"><span>WOODCAMP</span><span class="caption-separator">·</span><span>DAY 01</span><span class="caption-separator">·</span><span data-tick>00:00</span></div>
      </section>
      <aside class="observatory" aria-label="Agent observatory">
        <div class="observatory-head"><div class="eyebrow">WORLD OBSERVATORY <span class="head-index">01 / 01</span></div><h1>A living world,<br><em>in plain sight.</em></h1><p class="intro">Watch one small decision become a world you can understand.</p></div>
        <div class="agent-card"><div class="agent-avatar"><span></span></div><div class="agent-details"><div class="agent-title">MOSS <span class="agent-badge" data-agent-runtime>LOCAL POLICY</span></div><div class="agent-subtitle" data-agent-action>Watching the forest</div></div><span class="agent-pulse"></span></div>
        <div class="control-row"><button class="control-button" data-control="pause"><span class="pause-icon">Ⅱ</span><span data-control-label>PAUSE AGENT</span></button><div class="control-hint">HUMAN CONTROL <span>●</span></div></div>
        <section class="section-block command-block"><div class="section-heading"><span>COMMAND</span><span class="section-count" data-provider>PROVIDER · CHECKING</span></div><div class="mode-row" role="group" aria-label="Control mode"><button class="mode-button" data-mode-button="direct">DIRECT</button><button class="mode-button is-active" data-mode-button="delegated">DELEGATED</button><button class="mode-button" data-mode-button="supervised">SUPERVISED</button></div><form class="command-form" data-command-form><input class="command-input" data-command-input type="text" maxlength="240" placeholder="Command the settlement — e.g. gather food" aria-label="Settlement command" autocomplete="off"><button class="command-send" type="submit">SEND</button></form><div class="command-feedback" data-command-feedback aria-live="polite"></div><div class="goal-line" data-goal>GOAL · NONE</div></section>
        <section class="section-block approval-block"><div class="section-heading"><span>APPROVALS</span><span class="section-count" data-approval-count>0 PENDING</span></div><div class="approval-list" data-approvals aria-live="polite"><div class="approval-empty">No proposals awaiting review.</div></div></section>
        <section class="section-block plan-block"><div class="section-heading"><span>GOVERNED PLAN</span><span class="section-count" data-plan-count>NO PLAN</span></div><div class="plan-list" data-plans aria-live="polite"><div class="approval-empty">No active plan.</div></div></section>
        <section class="section-block"><div class="section-heading"><span>WOOD · TREE TO CABIN</span><span class="section-count">01 — 06</span></div><div class="causal-chain" data-chain="wood">
          <div class="chain-step" data-step="wood-target"><span class="chain-icon tree-icon">♧</span><span class="chain-name">Tree</span></div><span class="chain-arrow">→</span><div class="chain-step" data-step="wood-walk"><span class="chain-icon worker-icon">●</span><span class="chain-name">Worker</span></div><span class="chain-arrow">→</span><div class="chain-step" data-step="wood-chop"><span class="chain-icon chop-icon">✳</span><span class="chain-name">Chop</span></div><span class="chain-arrow">→</span><div class="chain-step" data-step="wood-log"><span class="chain-icon log-icon">▬</span><span class="chain-name">Log</span></div><span class="chain-arrow">→</span><div class="chain-step" data-step="wood-carry"><span class="chain-icon carry-icon">↗</span><span class="chain-name">Carry</span></div><span class="chain-arrow">→</span><div class="chain-step" data-step="wood-settle"><span class="chain-icon settle-icon">⌂</span><span class="chain-name">Store</span></div>
        </div></section>
        <section class="section-block food-chain-block"><div class="section-heading"><span>FOOD · BUSH TO CABIN</span><span class="section-count">02 — 06</span></div><div class="causal-chain" data-chain="food">
          <div class="chain-step" data-step="food-target"><span class="chain-icon">❋</span><span class="chain-name">Berries</span></div><span class="chain-arrow">→</span><div class="chain-step" data-step="food-walk"><span class="chain-icon worker-icon">●</span><span class="chain-name">Worker</span></div><span class="chain-arrow">→</span><div class="chain-step" data-step="food-harvest"><span class="chain-icon">✳</span><span class="chain-name">Gather</span></div><span class="chain-arrow">→</span><div class="chain-step" data-step="food-create"><span class="chain-icon">●</span><span class="chain-name">Basket</span></div><span class="chain-arrow">→</span><div class="chain-step" data-step="food-carry"><span class="chain-icon carry-icon">↗</span><span class="chain-name">Carry</span></div><span class="chain-arrow">→</span><div class="chain-step" data-step="food-settle"><span class="chain-icon settle-icon">⌂</span><span class="chain-name">Store</span></div>
        </div></section>
        <section class="section-block event-block"><div class="section-heading"><span>EVENT STREAM</span><span class="stream-indicator"><span></span> LIVE</span></div><div class="event-list" data-events aria-live="polite"></div><button class="log-toggle" data-control="events">VIEW STRUCTURED EVENTS <span>↗</span></button><pre class="event-json" data-json hidden></pre></section>
        <footer class="observatory-footer"><div><span class="footer-label">STATE</span><span class="state-pill"><span></span> LOCAL · NOT ONCHAIN</span></div><span class="build-mark">ASTRIX / FIELD NOTE 001</span></footer>
      </aside>
    </main>`;
  root.querySelector<HTMLButtonElement>('[data-control="pause"]')?.addEventListener('click', controls.onTogglePause);
  root.querySelector<HTMLButtonElement>('[data-control="events"]')?.addEventListener('click', controls.onToggleEvents);
  root.querySelector<HTMLFormElement>('[data-command-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = root.querySelector<HTMLInputElement>('[data-command-input]');
    const text = input?.value.trim() ?? '';
    if (text) {
      controls.onIssueCommand(text);
      if (input) input.value = '';
    }
  });
  root.querySelectorAll<HTMLButtonElement>('[data-mode-button]').forEach((button) => {
    button.addEventListener('click', () => controls.onSelectMode(button.dataset['modeButton'] ?? 'delegated'));
  });
  root.querySelector<HTMLElement>('[data-approvals]')?.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-approval-action]');
    if (!target) return;
    const proposalId = target.dataset['proposalId'] ?? '';
    if (target.dataset['approvalAction'] === 'approve') controls.onApproveProposal(proposalId);
    else controls.onRejectProposal(proposalId);
  });
}

export interface ApprovalRow {
  proposalId: string;
  label: string;
  riskLevel: string;
}

export interface SettledRow {
  proposalId: string;
  label: string;
  status: string;
}

const TERMINAL_PROPOSAL = new Set(['VERIFIED', 'FAILED', 'REJECTED', 'CANCELLED']);

/**
 * Pure approval bookkeeping (node-testable; renderApprovals renders it).
 * Pending = actionable PROPOSED items (last 4). Settled = terminal outcomes
 * most-recent-first (last 4 by monotonic proposal id) so completed, failed,
 * rejected, and cancelled work stay visible instead of vanishing.
 */
export function describeApprovals(
  proposals: readonly ActionProposal[],
  plans: Readonly<Record<string, { status: string }>> = {},
): { pending: ApprovalRow[]; settled: SettledRow[] } {
  const pending = proposals
    .filter((p) => p.status === 'PROPOSED')
    .slice(-4)
    .map((proposal): ApprovalRow => ({
      proposalId: proposal.id,
      label: proposal.actionType === 'PLAN' && typeof proposal.parameters['planId'] === 'string'
        ? `PLAN ${String(proposal.parameters['kind'] ?? 'plan')} ×${String(proposal.parameters['quantity'] ?? '')} · ${proposal.riskLevel} · ${plans[String(proposal.parameters['planId'])]?.status ?? ''}`.trim()
        : proposal.actionType === 'CRAFT' && typeof proposal.parameters['recipe'] === 'string'
          ? `CRAFT ${String(proposal.parameters['recipe'])} · ${proposal.riskLevel}`
          : proposal.actionType === 'BUILD' && typeof proposal.parameters['structure'] === 'string'
            ? `BUILD ${String(proposal.parameters['structure'])} · ${proposal.riskLevel}`
            : `${proposal.actionType} ${proposal.targetEntityId} · ${proposal.riskLevel}`,
      riskLevel: proposal.riskLevel,
    }));
  const settled = [...proposals]
    .filter((p) => TERMINAL_PROPOSAL.has(p.status))
    .sort((a, b) => (a.id < b.id ? 1 : -1))
    .slice(0, 4)
    .map((proposal): SettledRow => ({
      proposalId: proposal.id,
      label: proposal.actionType === 'PLAN' && typeof proposal.parameters['kind'] === 'string'
        ? `PLAN ${String(proposal.parameters['kind'])}`
        : proposal.actionType === 'CRAFT' && typeof proposal.parameters['recipe'] === 'string'
          ? `CRAFT ${String(proposal.parameters['recipe'])}`
          : `${proposal.actionType} ${proposal.targetEntityId}`,
      status: proposal.status,
    }));
  return { pending, settled };
}

export function renderApprovals(root: HTMLElement, state: Readonly<WorldState>): void {
  const list = root.querySelector<HTMLElement>('[data-approvals]');
  const count = root.querySelector<HTMLElement>('[data-approval-count]');
  if (!list) return;
  const { pending, settled } = describeApprovals(state.proposals, state.plans);
  if (count) count.textContent = `${pending.length} PENDING`;
  list.replaceChildren();
  if (pending.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'approval-empty';
    empty.textContent = 'No proposals awaiting review.';
    list.append(empty);
  }
  for (const row of pending) {
    const el = document.createElement('div');
    el.className = 'approval-row';
    const label = document.createElement('span');
    label.className = 'approval-label';
    label.textContent = row.label;
    const approve = document.createElement('button');
    approve.className = 'approval-button approval-approve';
    approve.textContent = 'APPROVE';
    approve.dataset['approvalAction'] = 'approve';
    approve.dataset['proposalId'] = row.proposalId;
    const reject = document.createElement('button');
    reject.className = 'approval-button approval-reject';
    reject.textContent = 'REJECT';
    reject.dataset['approvalAction'] = 'reject';
    reject.dataset['proposalId'] = row.proposalId;
    el.append(label, approve, reject);
    list.append(el);
  }
  if (settled.length > 0) {
    const heading = document.createElement('div');
    heading.className = 'section-heading';
    heading.textContent = 'RECENT OUTCOMES';
    list.append(heading);
    for (const row of settled) {
      const el = document.createElement('div');
      el.className = 'approval-row approval-settled';
      const label = document.createElement('span');
      label.className = 'approval-label';
      label.textContent = `${row.label} — ${row.status}`;
      el.append(label);
      list.append(el);
    }
  }
}

export function renderPlan(root: HTMLElement, state: Readonly<WorldState>): void {
  const list = root.querySelector<HTMLElement>('[data-plans]');
  const count = root.querySelector<HTMLElement>('[data-plan-count]');
  if (!list) return;
  const plans = Object.values(state.plans).sort((a, b) => (a.createdAt - b.createdAt)).slice(-2);
  const active = plans.filter((p) => p.status === 'active' || p.status === 'awaiting-approval' || p.status === 'blocked');
  if (count) count.textContent = active.length === 0 ? (plans.length === 0 ? 'NO PLAN' : String(plans[plans.length - 1]!.status).toUpperCase()) : `${active.length} ACTIVE`;
  if (plans.length === 0) {
    list.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'approval-empty';
    empty.textContent = 'No active plan.';
    list.append(empty);
    return;
  }
  list.replaceChildren();
  for (const plan of plans) {
    const row = document.createElement('div');
    row.className = 'approval-row';
    const label = document.createElement('span');
    label.className = 'approval-label';
    const verified = plan.steps.filter((s) => s.status === 'verified').length;
    label.textContent = `${plan.id} ${plan.kind} ×${plan.quantity} · ${plan.status} · ${verified}/${plan.steps.length} steps verified`;
    row.append(label);
    list.append(row);
    const last = plan.steps.slice(-3);
    for (const step of last) {
      const sub = document.createElement('div');
      sub.className = 'approval-empty';
      sub.textContent = `· ${step.actionType} ${step.targetEntityId} — ${step.status} (${step.note})`;
      list.append(sub);
    }
  }
  if (state.journal.length > 0) {
    // Interpretation provenance: which interpreter (deterministic parser or
    // model) produced the latest request, and whether it was admitted.
    const lastInterp = [...state.journal].reverse().find((j) => j.verdict.startsWith('interpreted') || j.verdict.startsWith('capability-') || j.verdict.startsWith('missing-capability') || j.verdict === 'interpretation-invalid');
    if (lastInterp) {
      const sub = document.createElement('div');
      sub.className = 'approval-empty';
      sub.dataset['interpretation'] = lastInterp.source;
      sub.textContent = `interpretation: ${lastInterp.source === 'command' ? 'deterministic parser' : lastInterp.source} → ${lastInterp.candidates[0] ?? 'none'} (${lastInterp.verdict})`;
      list.append(sub);
    }
    const lastReject = [...state.journal].reverse().find((j) => j.verdict.includes('reject') || j.verdict.includes('off-goal') || j.verdict.includes('invalid') || j.verdict.startsWith('plan-'));
    if (lastReject) {
      const sub = document.createElement('div');
      sub.className = 'approval-empty';
      sub.textContent = `last decision: ${lastReject.source} → ${lastReject.chosen ?? 'none'} (${lastReject.verdict})`;
      list.append(sub);
    }
  }
}

export function renderCommandFeedback(root: HTMLElement, message: string): void {
  const feedback = root.querySelector<HTMLElement>('[data-command-feedback]');
  if (feedback) feedback.textContent = message;
}

export function renderGoal(root: HTMLElement, text: string): void {
  const goal = root.querySelector<HTMLElement>('[data-goal]');
  if (goal) goal.textContent = text;
}

export function renderMode(root: HTMLElement, mode: string): void {
  root.querySelectorAll<HTMLElement>('[data-mode-button]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset['modeButton'] === mode);
  });
}

export function renderProvider(root: HTMLElement, text: string): void {
  const provider = root.querySelector<HTMLElement>('[data-provider]');
  if (provider) provider.textContent = text;
}

export function renderFarmAuthority(root: HTMLElement, text: string): void {
  const badge = root.querySelector<HTMLElement>('[data-farm]');
  if (badge) badge.textContent = text;
}

export function updateObservatory(root: HTMLElement, state: Readonly<WorldState>, latest: WorldEvent[], paused: boolean): void {
  const wood = root.querySelector<HTMLElement>('[data-wood]');
  if (wood) wood.textContent = String(state.wood).padStart(2, '0');
  const food = root.querySelector<HTMLElement>('[data-food]');
  if (food) food.textContent = String(state.food).padStart(2, '0');
  const water = root.querySelector<HTMLElement>('[data-water]');
  if (water) water.textContent = String(state.water).padStart(2, '0');
  const settlement = root.querySelector<HTMLElement>('[data-settlement]');
  if (settlement) {
    const population = Object.values(state.entities).filter((e) => e.kind === 'worker').length;
    const homes = Object.values(state.entities).filter((e) => e.kind === 'house' && e.state === 'complete').length;
    const farms = Object.values(state.entities).filter((e) => e.kind === 'farm').length;
    const inhabitant = state.entities['worker-01'];
    const pack = inhabitant?.kind === 'worker'
      ? ` · ${inhabitant.equipment.axe === 'stone-axe' ? 'STONE AXE' : 'AXE'}${inhabitant.equipment.basket ? '+BASKET' : ''} · PACK ${Object.values(inhabitant.inventory).reduce((sum, n) => sum + n, 0)}/${inhabitant.capacity}`
      : '';
    const shelterCount = Object.values(state.entities).filter((e) => e.kind === 'shelter' && e.state === 'complete').length;
    const rested = inhabitant?.kind === 'worker' && state.tick < inhabitant.restedUntilTick ? ' · RESTED' : '';
    settlement.textContent = `POP ${String(population).padStart(2, '0')} · HOMES ${String(homes).padStart(2, '0')} · FARMS ${String(farms).padStart(2, '0')} · SHELTER ${String(shelterCount).padStart(2, '0')}${pack}${rested}`;
  }
  const worker = state.entities['worker-01'];
  const activity = worker?.kind === 'worker' ? worker.activity : 'idle';
  const workerTarget = worker?.kind === 'worker' && worker.targetId ? state.entities[worker.targetId] : undefined;
  const planting = activity === 'gathering' && workerTarget?.kind === 'tree';
  const collecting = activity === 'moving' && (workerTarget?.kind === 'branch' || workerTarget?.kind === 'stone');
  const buildingShelter = activity === 'building' && worker?.kind === 'worker' && worker.task?.kind === 'build'
    ? state.entities[worker.task.targetId]
    : undefined;
  const actionText: Record<string, string> = { idle: 'Watching the clearing', moving: collecting ? `Gathering ${workerTarget?.kind}` : 'Walking to a resource', chopping: 'Chopping a tree', gathering: planting ? 'Planting a sapling' : 'Gathering berries', building: buildingShelter?.kind === 'shelter' ? 'Raising a shelter' : 'Raising a house', crafting: 'Crafting at the camp', resting: 'Resting at the shelter', carrying: worker?.kind === 'worker' && worker.carrying?.startsWith('food-') ? 'Bringing food home' : worker?.kind === 'worker' && worker.carrying?.startsWith('water-') ? 'Bringing water home' : 'Bringing wood home' };
  const action = root.querySelector<HTMLElement>('[data-agent-action]');
  if (action) action.textContent = paused ? 'Paused by you' : actionText[activity];
  const foodOnTheWay = worker?.kind === 'worker' && worker.carrying?.startsWith('food-');
  const waterOnTheWay = worker?.kind === 'worker' && worker.carrying?.startsWith('water-');
  const status = paused ? 'Moss is waiting for your signal.' : activity === 'chopping' ? 'Moss is gathering timber.' : activity === 'crafting' ? 'Moss is crafting at the camp.' : activity === 'resting' ? 'Moss is resting at the shelter.' : activity === 'gathering' ? planting ? 'Moss is planting a sapling.' : 'Moss is picking berries.' : activity === 'moving' && collecting ? `Moss is fetching ${workerTarget?.kind}.` : activity === 'carrying' ? foodOnTheWay ? 'A basket of berries is on its way home.' : waterOnTheWay ? 'A waterskin is on its way home.' : 'A log is on its way home.' : state.food > 0 ? 'Food is safely stored at the settlement.' : state.wood > 0 ? 'The settlement is growing, one log at a time.' : 'Moss is choosing the nearest standing tree.';
  root.querySelector<HTMLElement>('.world-note span:last-child')?.replaceChildren(document.createTextNode(status));
  const worldStatus = root.querySelector<HTMLElement>('[data-world-status]');
  if (worldStatus) worldStatus.textContent = status;
  const tick = root.querySelector<HTMLElement>('[data-tick]');
  if (tick) tick.textContent = `${String(Math.floor(state.tick * 0.16 / 60)).padStart(2, '0')}:${String(Math.floor(state.tick * 0.16) % 60).padStart(2, '0')}`;
  const buttonText = root.querySelector<HTMLElement>('[data-control-label]');
  if (buttonText) buttonText.textContent = paused ? 'RESUME AGENT' : 'PAUSE AGENT';
  const pauseIcon = root.querySelector<HTMLElement>('.pause-icon');
  if (pauseIcon) pauseIcon.textContent = paused ? '▶' : 'Ⅱ';
  root.querySelector('.control-button')?.classList.toggle('is-paused', paused);

  const eventList = root.querySelector<HTMLElement>('[data-events]');
  if (eventList && latest.length > 0) {
    const important = latest.filter((event) => event.type !== 'AGENT_MOVED' && event.type !== 'ACTION_STATUS_CHANGED');
    if (important.length) {
      const existing = new Set([...eventList.querySelectorAll<HTMLElement>('[data-event-id]')].map((row) => row.dataset['eventId']));
      const rows = important.filter((event) => !existing.has(event.id)).map((event) => `<div class="event-row" data-event-id="${event.id}"><span class="event-marker ${event.type === 'RESOURCE_ADDED' ? 'event-success' : ''}"></span><span class="event-name">${eventLabel(event)}</span><span class="event-entity">${escapeHtml(event.entityId ?? 'world')}</span><span class="event-sequence">${String(event.sequence).padStart(3, '0')}</span></div>`).join('');
      if (rows) {
        eventList.insertAdjacentHTML('afterbegin', rows);
        while (eventList.children.length > 8) eventList.lastElementChild?.remove();
      }
      const requiredChain = latest.some((event) => event.data['resource'] === 'food')
        ? ['Agent observed nearby resources', 'Agent chose berry harvest', 'Harvest proposed', 'Berry patch selected', 'Berry gathering started', 'Berries gathered', 'Food basket created', 'Food pickup proposed', 'Food picked up', 'Food delivered', 'Food added']
        : ['Agent observed nearby resources', 'Agent chose a tree', 'Tree chop proposed', 'Tree selected', 'Chopping started', 'Tree chopped', 'Log created', 'Log pickup proposed', 'Log picked up', 'Log delivered', 'Wood added'];
      const retained = requiredChain
        .map((label) => ({ label, event: [...state.events].reverse().find((event) => eventLabel(event) === label && (!['Agent observed nearby resources', 'Agent chose berry harvest', 'Agent chose a tree', 'Harvest proposed', 'Tree chop proposed', 'Food pickup proposed', 'Log pickup proposed'].includes(label) || event.data['actionType'] !== 'PICK_UP')) }))
        .filter((item): item is { label: string; event: WorldEvent } => Boolean(item.event))
        .sort((left, right) => left.event.sequence - right.event.sequence)
        .slice(-8);
      eventList.replaceChildren();
      for (const { label, event } of retained) {
        const row = document.createElement('div');
        row.className = 'event-row';
        row.dataset['eventId'] = event.id;
        row.innerHTML = `<span class="event-marker ${event.type === 'RESOURCE_ADDED' ? 'event-success' : ''}"></span><span class="event-name">${label}</span><span class="event-entity">${escapeHtml(event.entityId ?? 'world')}</span><span class="event-sequence">${String(event.sequence).padStart(3, '0')}</span>`;
        eventList.append(row);
      }
      while (eventList.children.length > 8) eventList.lastElementChild?.remove();
    }
  }
  for (const event of latest) {
    // Water flows through its own loop: it must not light either the wood or
    // the food causal chain. Only wood/food events advance chain visuals.
    // Materials and crafting are their own story: they must not light the
    // wood chain by default either.
    if (event.data['resource'] === 'water' || event.entityId?.startsWith('water-') || event.entityId === 'well-01') continue;
    if (event.type === 'MATERIAL_COLLECTED' || event.type.startsWith('CRAFTING') || event.entityId?.startsWith('branch-') || event.entityId?.startsWith('stone-')) continue;
    if (event.type === 'REST_COMPLETED' || event.type === 'CONSTRUCTION_STAGE' || event.entityId?.startsWith('shelter-')) continue;
    const food = event.data['resource'] === 'food' || event.data['resourceType'] === 'food' || event.data['resourceId']?.toString().startsWith('food-') || event.entityId?.startsWith('berry-patch-') || event.entityId?.startsWith('food-');
    const prefix = food ? 'food-' : 'wood-';
    const step = event.type === 'RESOURCE_TARGETED' ? `${prefix}target` : event.type === 'AGENT_MOVED' ? `${prefix}walk` : event.type === 'GATHER_ACTION_STARTED' || event.type === 'TREE_DAMAGED' || event.type === 'TREE_CHOPPED' || event.type === 'BERRY_PATCH_HARVESTED' ? `${prefix}${food ? 'harvest' : 'chop'}` : event.type === 'RESOURCE_CREATED' ? `${prefix}${food ? 'create' : 'log'}` : event.type === 'RESOURCE_PICKED_UP' ? `${prefix}carry` : event.type === 'RESOURCE_DELIVERED' || event.type === 'RESOURCE_ADDED' ? `${prefix}settle` : null;
    if (step) root.querySelector(`[data-step="${step}"]`)?.classList.add('is-active', 'is-done');
  }
  const json = root.querySelector<HTMLElement>('[data-json]');
  if (json && !json.hidden) json.textContent = JSON.stringify({ tick: state.tick, wood: state.wood, food: state.food, water: state.water, events: state.events.filter((event) => event.type !== 'AGENT_MOVED').slice(-60), proposals: state.proposals.slice(-8), plans: Object.values(state.plans).slice(-4), journal: state.journal.slice(-8) }, null, 2);
  renderPlan(root, state);
}

function eventLabel(event: WorldEvent): string {
  const resource = event.data['resource'];
  if (event.type === 'AGENT_OBSERVED') return 'Agent observed nearby resources';
  if (event.type === 'AGENT_DECIDED') return event.data['actionType'] === 'HARVEST' ? 'Agent chose berry harvest' : event.data['actionType'] === 'GATHER' ? 'Agent chose a tree' : event.data['actionType'] === 'PLANT' ? 'Agent chose replanting' : 'Agent chose to carry';
  if (event.type === 'RESOURCE_TARGETED') return resource === 'food' ? 'Berry patch selected' : event.data['purpose'] === 'replant' ? 'Stump selected' : 'Tree selected';
  if (event.type === 'GATHER_ACTION_STARTED') return resource === 'food' ? 'Berry gathering started' : event.data['purpose'] === 'replant' ? 'Planting started' : 'Chopping started';
  if (event.type === 'RESOURCE_CREATED') return resource === 'food' ? 'Food basket created' : resource === 'water' ? 'Waterskin filled' : 'Log created';
  if (event.type === 'RESOURCE_PICKED_UP') return resource === 'food' ? 'Food picked up' : resource === 'water' ? 'Water picked up' : 'Log picked up';
  if (event.type === 'RESOURCE_DELIVERED') return resource === 'food' ? 'Food delivered' : resource === 'water' ? 'Water delivered' : 'Log delivered';
  if (event.type === 'RESOURCE_ADDED') return resource === 'food' ? 'Food added' : resource === 'water' ? 'Water added' : 'Wood added';
  if (event.type === 'ACTION_PROPOSED' && event.data['actionType'] === 'HARVEST') return 'Harvest proposed';
  if (event.type === 'ACTION_PROPOSED' && event.data['actionType'] === 'GATHER') return 'Tree chop proposed';
  if (event.type === 'ACTION_PROPOSED' && event.data['actionType'] === 'PICK_UP') return event.data['resourceId']?.toString().startsWith('food-') ? 'Food pickup proposed' : 'Log pickup proposed';
  if (event.type === 'ACTION_PROPOSED' && event.data['actionType'] === 'PLAN') return `Plan proposed (${String(event.data['kind'] ?? 'goal')})`;
  if (event.type === 'PLAN_STATUS_CHANGED') return `Plan ${String(event.data['status'] ?? 'updated')}`;
  if (event.type === 'CONSTRUCTION_STAGE') return `${event.data['structureType'] === 'house' ? String(event.data['blueprint'] ?? 'house') : 'Shelter'} ${String(event.data['stage'] ?? 'stage')} raised`;
  if (event.type === 'CONSTRUCTION_STARTED' && event.data['deviation']) return 'Construction started (site shifted within tolerance)';
  if (event.type === 'CONSTRUCTION_FAILED' && event.data['reason'] === 'invalid-placement') return `Construction refused: ${String(event.data['siteReason'] ?? 'invalid site')}`;
  if (event.type === 'MATERIAL_COLLECTED') return `${event.data['material'] === 'stone' ? 'Stone' : 'Branch'} collected`;
  if (event.type === 'CRAFTING_STARTED') return `Crafting ${String(event.data['recipe'] ?? 'item')} started`;
  if (event.type === 'CRAFTING_COMPLETED') return `${String(event.data['recipe'] ?? 'item')} crafted`;
  if (event.type === 'CRAFTING_FAILED') return `Crafting failed (${String(event.data['reason'] ?? 'unknown')})`;
  return labels[event.type] ?? event.type;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}
