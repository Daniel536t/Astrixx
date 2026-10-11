/**
 * Player goals: explicit, inspectable objectives derived from commands.
 * A goal persists until completed, cancelled, invalidated, or replaced.
 */
import type { WorldState } from '../world/types';
import { getRecipe, recipeSatisfied } from './recipes';
import { MISSING_CAPABILITIES } from './capabilities';
import { parsePlaceIntent, type PlaceIntent } from './placement';

export type GoalKind = 'gather-wood' | 'gather-food' | 'fetch-water' | 'construct-house' | 'construct-farm' | 'construct-shelter' | 'preserve' | 'prioritize' | 'plant' | 'craft';

export interface GameGoal {
  id: string;
  kind: GoalKind;
  /** Target quantity (stockpile units, houses/shelters for construction). */
  quantity: number;
  /** For preserve/prioritize: which resource. */
  resource?: 'wood' | 'food';
  /** For craft: which recipe to complete. */
  recipe?: string;
  /** For construction: resolved build site (world coords, optional). */
  site?: { x: number; z: number };
  /** True when `site` is exact player coordinates: no tolerance search. */
  exactSite?: boolean;
  /** Human-readable derivation of `site` (requested vs resolved). */
  siteNote?: string;
  /** For construct-house: blueprint id (default homestead). */
  blueprint?: string;
  /** Raw placement intent from the command; resolved to `site` before the goal starts. */
  place?: PlaceIntent;
  /** Resources the planner must not gather while this goal is active. */
  avoid?: Array<'wood' | 'food'>;
  status: 'active' | 'completed' | 'cancelled' | 'invalid';
  /** Human-readable rationale, including feasibility notes. */
  note: string;
  createdAt: number;
}

export type ParseResult =
  | { ok: true; goal: Omit<GameGoal, 'id' | 'status' | 'createdAt'> }
  | { ok: false; clarify: string; gap?: string };

const CAPABILITIES =
  'I can gather wood, harvest food, fetch water from the well, collect branches and stones, craft a stone axe or a carrying basket at the camp, rest at a shelter, deliver stockpiles, plant trees on felled stumps, and build houses (2 wood each) or a wilderness shelter (2 wood + 2 branches). ' +
  'There is no river or gap in this world, so bridges cannot be built. Bows, knives, and granaries are not craftable yet; hunting and taming are not implemented. ' +
  'Examples: "gather food", "fetch water", "make a better axe", "build a shelter", "build a house", "plant trees", "prioritize food", "keep food above 2".';

function qty(match: RegExpMatchArray | null, fallback: number): number {
  if (!match) return fallback;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, 1000) : fallback;
}

/** Honest missing-capability answer from the shared registry, with a gap key for the audit trail. */
function missing(topic: keyof typeof MISSING_CAPABILITIES | string): ParseResult {
  const entry = MISSING_CAPABILITIES[topic];
  if (!entry) return { ok: false, clarify: `I did not understand a world action. ${CAPABILITIES}` };
  const alternative = entry.alternative ? ` ${entry.alternative}.` : '';
  return {
    ok: false,
    clarify: `I understood you want ${entry.understood}, but ${entry.missing} — not implemented.${alternative}`,
    gap: topic,
  };
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** Quantity from digits ("3", "100") or number words ("two"); else fallback. */
function qtyFrom(input: string, fallback: number): number {
  const digits = input.match(/\b(\d+)\b/);
  if (digits) return qty(digits, fallback);
  const word = input.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/);
  if (word && word[1]) return NUMBER_WORDS[word[1]] ?? fallback;
  return fallback;
}

/** Deterministic command parser. Ambiguous input returns a clarification, never a guessed goal. */
export function parseCommand(text: string): ParseResult {
  const input = text.toLowerCase().trim();
  if (!input) return { ok: false, clarify: `Empty command. ${CAPABILITIES}` };

  if (/\bcancel\b.*\bgoal\b/.test(input) || /\bstop\b.*\bgoal\b/.test(input) || input === 'stop' || input === 'cancel') {
    return { ok: true, goal: { kind: 'prioritize', quantity: 0, note: '__CANCEL__' } };
  }

  if (/\bbridge\b/.test(input)) {
    return missing('bridge');
  }
  if (/\b(status|report|what is|how much|stockpile levels|overview)\b/.test(input) && !/\b(gather|collect|build|stockpile timber|stockpile wood)\b/.test(input)) {
    return { ok: false, clarify: '__STATUS__' };
  }
  if (/\b(stop|don't|do not)\b.*\bwood\b/.test(input) || /\bprioritize\b.*\bfood\b/.test(input) || /\bprioritise\b.*\bfood\b/.test(input)) {
    return { ok: true, goal: { kind: 'prioritize', quantity: 0, resource: 'food', avoid: ['wood'], note: 'Food first; wood gathering paused until this goal is replaced.' } };
  }
  if (/\b(stop|don't|do not)\b.*\bfood\b/.test(input) || /\bprioritize\b.*\bwood\b/.test(input) || /\bprioritise\b.*\bwood\b/.test(input)) {
    return { ok: true, goal: { kind: 'prioritize', quantity: 0, resource: 'wood', avoid: ['food'], note: 'Wood first; food gathering paused until this goal is replaced.' } };
  }
  const keepMatch = input.match(/\bkeep\b.*\b(food|wood)\b.*\babove\b.*\b(\d+)\b/) || input.match(/\bpreserve\b.*\b(food|wood)\b/);
  if (keepMatch) {
    const resource = (keepMatch[1] ?? 'food') as 'wood' | 'food';
    const minimum = qtyFrom(input, 2);
    const effort = minimum > 5 ? ` At roughly one unit per gathering trip, reaching ${minimum} takes sustained work.` : '';
    return { ok: true, goal: { kind: 'preserve', quantity: minimum, resource, note: `Hold ${resource} at or above ${minimum}.${effort}` } };
  }
  if (/\b(build|construct)\b.*\bfarm\b/.test(input)) {
    const n = Math.min(qtyFrom(input, 1), 2);
    return { ok: true, goal: { kind: 'construct-farm', quantity: n, note: `Complete ${n} farm(s) for renewable food; each costs 3 wood and needs approval under restrictive policies. Only 2 farm plots exist.` } };
  }
  if (/\b(build|construct|raise|put up)\b.*\bshelter\b/.test(input) || (/\bshelter\b/.test(input) && /\b(need|want)\b/.test(input))) {
    const n = Math.min(qtyFrom(input, 1), 3);
    const place = parsePlaceIntent(input);
    return { ok: true, goal: { kind: 'construct-shelter', quantity: n, place: place.intent, siteNote: place.note, note: `Raise ${n} wilderness shelter(s)${place.intent.kind === 'auto' ? '' : ` (${place.note})`}; each costs 2 wood + 2 branches and needs approval under restrictive policies. A finished shelter is a verified rest stop that speeds later work.` } };
  }
  // Paraphrase, not synonym list: tool-for-cutting-trees names the craft goal.
  if (/\b(tools?|implements?|axes?)\b/.test(input) && /\b(cutting|chopping|trees?|timber|better|improv\w*|upgrad\w*)\b/.test(input) && /\b(make|build|craft|get|give|need|want|creat\w*)\b/.test(input)) {
    return { ok: true, goal: { kind: 'craft', quantity: 1, recipe: 'stone-axe', note: 'Craft a stone axe (3 branches + 2 stones, shaped with the basic axe at camp); it fells trees in one blow.' } };
  }
  // "Somewhere to sleep / something cozy" honestly maps to the rest stop.
  if (/\b(coz\w*|sleep\w*|rest\w*|nap\w*|tired|nights?)\b/.test(input) && /\b(make|build|give|need|want|place|somewhere)\b/.test(input) && !/\b(house|home|cabin|shelter)\b/.test(input)) {
    return { ok: true, goal: { kind: 'construct-shelter', quantity: 1, note: 'A lean-to shelter is the world\'s rest stop: 2 wood + 2 branches, then rest runs 1.5× faster.' } };
  }
  if (/\b(store|stores|stored|storing|storage|stockpile|keep|keeping|kept|save|saved|saving)\b.*\bfood\b/.test(input) || /\bgranar\w*\b/.test(input) || /\bfood\b.*\b(store|stores|stored|storing|storage|stockpile)\b/.test(input)) {
    return missing('granary');
  }
  if (/\b(defen\w*|protect\w*|guard\w*|walls?|fort\w*|attack\w*|enem\w*|raid\w*|soldiers?|arms?)\b/.test(input)) {
    return missing('defense');
  }
  if (/\bwarm\w*|\bheat\w*|\bcold\b|\bfreez\w*|\bwinter\b|\bfirewood\b/.test(input)) {
    return missing('warmth');
  }
  if (/\brivers?|\bacross\b|\bbridge\w*|\bcrossing\b|\bford\b/.test(input)) {
    return missing('bridge');
  }
  if (/\bfish\w*|\brods?\b/.test(input)) {
    return missing('fishing');
  }
  if (/\bmine\w*|\bores?\b|\bcoal\b|\biron\b|\bquarry\b/.test(input)) {
    return missing('mining');
  }
  if (/\bworkshop\b/.test(input)) {
    return missing('workshop');
  }
  if (/\b(organiz\w*|layout|arrange\w*|plan the|design the)\b/.test(input) && /\b(settlement|town|village|base|camp|houses|buildings)\b/.test(input)) {
    return missing('layout');
  }
  if (/\bcheapest\b.*\bhouse\b/.test(input) || /\bhouse\b.*\bcheapest\b/.test(input)) {
    return {
      ok: false,
      clarify: 'Cheapest is the homestead at 2 wood (say "build a house"). The thatched cottage costs 2 wood + 2 branches and the timber cabin costs 4 wood — say "build a cottage" or "build a cabin" to choose either.',
    };
  }
  if (/\b(build|construct)\b.*\bhouse\b/.test(input) || /\bgather\b.*\bwood\b.*\bhouse\b/.test(input) || /\benough wood\b.*\bconstruct\b/.test(input)) {
    const n = Math.min(qtyFrom(input, 1), 3);
    const place = parsePlaceIntent(input);
    return { ok: true, goal: { kind: 'construct-house', quantity: n, blueprint: 'homestead', place: place.intent, siteNote: place.note, note: `Complete ${n} homestead(s)${place.intent.kind === 'auto' ? '' : ` (${place.note})`}; each costs 2 wood and needs approval under restrictive policies.` } };
  }
  if (/\b(timber cabin|log cabin|cabin)\b/.test(input) && /\b(build|construct|need|want)\b/.test(input)) {
    const n = Math.min(qtyFrom(input, 1), 3);
    const place = parsePlaceIntent(input);
    return { ok: true, goal: { kind: 'construct-house', quantity: n, blueprint: 'timber-cabin', place: place.intent, siteNote: place.note, note: `Raise ${n} timber cabin(s)${place.intent.kind === 'auto' ? '' : ` (${place.note})`}; each costs 4 wood and needs approval. Taller and roomier than the homestead.` } };
  }
  if (/\b(thatched cottage|\bcottage\b|thatched)\b/.test(input) && /\b(build|construct|need|want)\b/.test(input)) {
    const n = Math.min(qtyFrom(input, 1), 3);
    const place = parsePlaceIntent(input);
    return { ok: true, goal: { kind: 'construct-house', quantity: n, blueprint: 'thatched-cottage', place: place.intent, siteNote: place.note, note: `Raise ${n} thatched cottage(s)${place.intent.kind === 'auto' ? '' : ` (${place.note})`}; each costs 2 wood + 2 branches and needs approval.` } };
  }
  if (/\b(house|home|cabin|shelter)\b/.test(input) && /\b(build|construct|need|want)\b/.test(input)) {
    const place = parsePlaceIntent(input);
    return { ok: true, goal: { kind: 'construct-house', quantity: 1, blueprint: 'homestead', place: place.intent, siteNote: place.note, note: 'Complete 1 homestead; costs 2 wood, adds housing for 2, and needs approval under restrictive policies.' } };
  }
  if (/\b(expansion|expand|prepare the settlement)\b/.test(input)) {
    return { ok: true, goal: { kind: 'construct-house', quantity: 1, note: 'Expansion starts with housing: complete 1 house (2 wood) so a newcomer has room.' } };
  }
  if (/\b(plant|replant|sow)\b.*\b(tree|s-tree|sapling|forest|wood|timber)/.test(input) || /\b(reforest|reforestation)\b/.test(input)) {
    return { ok: true, goal: { kind: 'plant', quantity: 0, note: 'Replant felled stump sites; saplings mature into standing timber on their own.' } };
  }
  if (/\b(axe|hatchet)\b/.test(input) && /\b(make|craft|build|better|improve|upgrade|new|need|want|stone)\b/.test(input)) {
    return { ok: true, goal: { kind: 'craft', quantity: 1, recipe: 'stone-axe', note: 'Craft a stone axe (3 branches + 2 stones, shaped with the basic axe at camp); it fells trees in one blow.' } };
  }
  if (/\b(basket|carrying|carry more|pack)\b/.test(input) && /\b(make|craft|build|weave|new|need|want)\b/.test(input)) {
    return { ok: true, goal: { kind: 'craft', quantity: 1, recipe: 'carrying-basket', note: 'Weave a carrying basket (4 branches at camp); it raises inventory capacity from 10 to 15.' } };
  }
  if (/\b(make|craft|build|forge|create)\b.*\b(bow|arrow|knife|sword|spear|granary|workshop|kiln|furnace)\b/.test(input)) {
    return {
      ok: false,
      clarify: 'That item needs mechanics this world does not have yet (no hunting, no milling). Right now I can craft a stone axe ("make a better axe") or a carrying basket ("make a basket") from branches and stones.',
    };
  }
  if (/\bassign\b.*\bworkers?\b/.test(input)) {
    return { ok: true, goal: { kind: 'gather-wood', quantity: 2, note: 'Idle workers take material-gathering tasks toward 2 wood for the next building.' } };
  }
  if (/\b(animals?|deer|doe|stag|fawn|rabbits?|bunn(y|ies)|hares?|beasts?|wildlife|creatures?)\b/.test(input) || /\b(hunt\w*|tame\w*|catch\w*|trap\w*|pets?|lure\w*|stalk\w*|kill\w*|rais\w*|rid\w*|bring\w*)\b/.test(input) && /\b(animal|animals|deer|rabbit|beast|creature|it|them)\b/.test(input)) {
    // Capture verbs (get/catch/hunt/tame/raise/bring + animal) name a missing
    // capability and record its gap; bare mentions keep the deer-watch answer.
    if (/\b(get|got|catch\w*|hunt\w*|kill\w*|trap\w*|tame\w*|pets?|rais\w*|bring\w*|rid\w*)\b/.test(input)) {
      // Possession verbs (get/tame/raise/bring) mean taming; killing verbs
      // mean hunting. Mixed or unclear verbs default to hunting's answer,
      // which names both gaps' alternatives.
      return /\b(tame\w*|pets?|rais\w*|bring\w*|get|got)\b/.test(input) && !/\b(hunt\w*|kill\w*|catch\w*|trap\w*)\b/.test(input)
        ? missing('taming')
        : missing('hunting');
    }
    return {
      ok: false,
      clarify: 'The deer (deer-01) wanders the clearing — watch it with "status", and I can tell you where it is. But hunting, trapping, taming, and harvesting animals are not implemented: I have no weapon, trap, or pen mechanics, so I cannot catch or use it. I can gather wood, food, and water, collect branches and stones, craft a stone axe or basket, build a shelter or house, or plant trees.',
    };
  }
  if (/\bwater\b/.test(input)) {
    const n = qtyFrom(input, 1);
    return { ok: true, goal: { kind: 'fetch-water', quantity: n, note: `Draw ${n} water from the well to the settlement stockpile.` } };
  }
  if (/\b(harvest|gather|collect|fetch)\b.*\b(food|berr)/.test(input) || /\bfood\b/.test(input)) {
    const n = qtyFrom(input, 1);
    return { ok: true, goal: { kind: 'gather-food', quantity: n, note: `Deliver ${n} food to the settlement stockpile.` } };
  }
  if (/\b(gather|collect|chop|fetch|get)\b.*\b(wood|timber|logs?)\b/.test(input) || (/\bwood\b/.test(input) && !/\bpreserve\b/.test(input))) {
    const n = qtyFrom(input, 1);
    return { ok: true, goal: { kind: 'gather-wood', quantity: n, note: `Deliver ${n} wood to the settlement stockpile.` } };
  }
  return { ok: false, clarify: `I did not understand a world action in "${text}". ${CAPABILITIES}` };
}

export function isGoalComplete(goal: GameGoal, state: Readonly<WorldState>): boolean {
  switch (goal.kind) {
    case 'gather-wood':
      return state.wood >= goal.quantity;
    case 'gather-food':
      return state.food >= goal.quantity;
    case 'fetch-water':
      return state.water >= goal.quantity;
    case 'construct-house': {
      const houses = Object.values(state.entities).filter((e) => e.kind === 'house' && e.state === 'complete');
      if (!goal.blueprint || goal.blueprint === 'homestead') {
        // Legacy default: any finished house counts (old homesteads carry no blueprint tag).
        return houses.length >= goal.quantity;
      }
      return houses.filter((e) => e.kind === 'house' && e.state === 'complete' && (e.blueprint ?? 'homestead') === goal.blueprint).length >= goal.quantity;
    }
    case 'construct-farm':
      return Object.values(state.entities).filter((e) => e.kind === 'farm').length >= goal.quantity;
    case 'construct-shelter':
      return Object.values(state.entities).filter((e) => e.kind === 'shelter' && e.state === 'complete').length >= goal.quantity;
    case 'preserve':
      return (goal.resource === 'wood' ? state.wood : state.food) >= goal.quantity;
    case 'prioritize':
      return false; // persists until replaced or cancelled
    case 'plant':
      return !Object.values(state.entities).some((e) => e.kind === 'tree' && e.state === 'depleted');
    case 'craft': {
      const recipe = getRecipe(goal.recipe ?? '');
      if (!recipe) return true; // unknown recipe can never complete; treat as done so it does not spin
      return recipeSatisfied(state, 'worker-01', recipe);
    }
  }
}

export class GoalTracker {
  private counter = 1;
  active: GameGoal | null = null;
  readonly history: GameGoal[] = [];

  setGoal(goal: Omit<GameGoal, 'id' | 'status' | 'createdAt'>, tick: number): GameGoal {
    if (this.active && this.active.status === 'active') {
      this.active.status = 'cancelled';
      this.history.push(this.active);
    }
    const created: GameGoal = { ...goal, id: `goal-${String(this.counter++).padStart(2, '0')}`, status: 'active', createdAt: tick };
    this.active = created;
    return created;
  }

  cancel(): GameGoal | null {
    if (this.active && this.active.status === 'active') {
      this.active.status = 'cancelled';
      this.history.push(this.active);
      const done = this.active;
      this.active = null;
      return done;
    }
    return null;
  }

  /** Re-check the active goal against authoritative state. Returns it if its status changed. */
  update(state: Readonly<WorldState>): GameGoal | null {
    if (this.active && this.active.status === 'active' && isGoalComplete(this.active, state)) {
      this.active.status = 'completed';
      this.history.push(this.active);
      const done = this.active;
      this.active = null;
      return done;
    }
    return null;
  }
}
