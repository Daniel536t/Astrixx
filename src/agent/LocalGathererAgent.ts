import type { ActionProposal, WorldState } from '../world/types';
import { distance, SETTLEMENT_ID, WORKER_ID } from '../world/types';
import type { ActionGateway, Agent, AgentDecision, AgentObservation } from './Agent';

export class LocalGathererAgent implements Agent {
  readonly id = WORKER_ID;

  observe(state: Readonly<WorldState>): AgentObservation {
    const worker = state.entities[WORKER_ID];
    const settlement = state.entities[SETTLEMENT_ID];
    if (!worker || worker.kind !== 'worker' || !settlement || settlement.kind !== 'settlement') {
      throw new Error('Agent observation requires the initial worker and settlement.');
    }
    const workers = Object.values(state.entities)
      .filter((entity) => entity.kind === 'worker')
      .map((entity) => {
        if (entity.kind !== 'worker') throw new Error('unreachable');
        return { id: entity.id, x: entity.position.x, z: entity.position.z, carrying: entity.carrying, activity: entity.activity };
      });
    const claimedTargetIds = Object.values(state.entities)
      .filter((entity) => entity.kind === 'worker' && entity.id !== worker.id && entity.targetId !== null)
      .map((entity) => (entity as { targetId: string }).targetId);
    return {
      tick: state.tick,
      wood: state.wood,
      food: state.food,
      water: state.water,
      worker: { id: worker.id, x: worker.position.x, z: worker.position.z, carrying: worker.carrying },
      workers,
      claimedTargetIds,
      settlement: { id: settlement.id, x: settlement.position.x, z: settlement.position.z },
      trees: Object.values(state.entities).filter((entity) => entity.kind === 'tree').map((tree) => ({ id: tree.id, x: tree.position.x, z: tree.position.z, available: tree.state === 'standing' })),
      stumps: Object.values(state.entities).filter((entity) => entity.kind === 'tree' && entity.state === 'depleted').map((tree) => ({ id: tree.id, x: tree.position.x, z: tree.position.z })),
      logs: Object.values(state.entities).filter((entity) => entity.kind === 'log').map((log) => ({ id: log.id, x: log.position.x, z: log.position.z, available: log.state === 'ground' })),
      berryPatches: Object.values(state.entities).filter((entity) => entity.kind === 'berry-patch').map((patch) => ({ id: patch.id, x: patch.position.x, z: patch.position.z, available: patch.state === 'available' })),
      farms: Object.values(state.entities).filter((entity) => entity.kind === 'farm').map((farm) => ({ id: farm.id, x: farm.position.x, z: farm.position.z, available: farm.state === 'ready' })),
      foodResources: [
        ...Object.values(state.entities).filter((entity) => entity.kind === 'food').map((food) => ({ id: food.id, x: food.position.x, z: food.position.z, available: food.state === 'ground', kind: 'food' as const })),
        ...Object.values(state.entities).filter((entity) => entity.kind === 'water').map((water) => ({ id: water.id, x: water.position.x, z: water.position.z, available: water.state === 'ground', kind: 'water' as const })),
      ],
      wells: [
        ...Object.values(state.entities).filter((entity) => entity.kind === 'well').map((well) => ({ id: well.id, x: well.position.x, z: well.position.z })),
        ...Object.values(state.entities).filter((entity) => entity.kind === 'pond').map((pond) => ({ id: pond.id, x: pond.position.x, z: pond.position.z })),
      ],
      branches: Object.values(state.entities).filter((entity) => entity.kind === 'branch').map((branch) => ({ id: branch.id, x: branch.position.x, z: branch.position.z, available: branch.state === 'ground', kind: 'branch' as const })),
      stones: Object.values(state.entities).filter((entity) => entity.kind === 'stone').map((stone) => ({ id: stone.id, x: stone.position.x, z: stone.position.z, available: stone.state === 'ground', kind: 'stone' as const })),
      shelters: Object.values(state.entities).filter((entity) => entity.kind === 'shelter').map((shelter) => ({ id: shelter.id, x: shelter.position.x, z: shelter.position.z, complete: shelter.state === 'complete' })),
      houses: Object.values(state.entities).filter((entity) => entity.kind === 'house').map((house) => ({ id: house.id, x: house.position.x, z: house.position.z, complete: house.state === 'complete', blueprint: house.blueprint ?? 'homestead' })),
      animals: Object.values(state.entities).filter((entity) => entity.kind === 'animal').map((animal) => ({ id: animal.id, species: animal.species, x: animal.position.x, z: animal.position.z, state: animal.state })),
      inventory: { ...worker.inventory },
      equipment: { ...worker.equipment },
      capacity: worker.capacity,
    };
  }

  decide(observation: AgentObservation): AgentDecision | null {
    if (observation.worker.carrying) return null;
    const claimed = new Set(observation.claimedTargetIds);
    const availableFood = observation.foodResources.find((food) => food.kind === 'food' && food.available && !claimed.has(food.id));
    if (availableFood) return { actionType: 'PICK_UP', targetEntityId: availableFood.id, reason: 'Fresh berries are ready to carry back.' };
    const availableLog = observation.logs.find((log) => log.available && !claimed.has(log.id));
    if (availableLog) return { actionType: 'PICK_UP', targetEntityId: availableLog.id, reason: 'A created log is ready to carry back.' };
    if (observation.wood < 1) {
      const nearestTree = observation.trees.filter((tree) => tree.available && !claimed.has(tree.id)).sort((a, b) => distance({ x: observation.worker.x, z: observation.worker.z }, { x: a.x, z: a.z }) - distance({ x: observation.worker.x, z: observation.worker.z }, { x: b.x, z: b.z }))[0];
      if (nearestTree) return { actionType: 'GATHER', targetEntityId: nearestTree.id, reason: 'The settlement needs timber; choose the nearest standing tree.' };
    } else if (observation.food < 1) {
      const patches = observation.berryPatches.filter((patch) => patch.available && !claimed.has(patch.id));
      const readyFarms = observation.farms.filter((farm) => farm.available && !claimed.has(farm.id));
      const options = [...patches.map((p) => ({ ...p, kind: 'patch' as const })), ...readyFarms.map((f) => ({ ...f, kind: 'farm' as const }))];
      const nearest = options.sort((a, b) => distance({ x: observation.worker.x, z: observation.worker.z }, { x: a.x, z: a.z }) - distance({ x: observation.worker.x, z: observation.worker.z }, { x: b.x, z: b.z }))[0];
      if (nearest) return { actionType: 'HARVEST', targetEntityId: nearest.id, reason: 'The settlement needs food; gather from the nearest source.' };
    }
    return null;
  }

  proposeAction(gateway: ActionGateway, decision: AgentDecision): ActionProposal {
    return gateway.proposeAction(decision.actionType, decision.targetEntityId, { reason: decision.reason }, 'LOW');
  }

  executeAction(gateway: ActionGateway, proposal: ActionProposal): boolean {
    if (proposal.status === 'EXECUTING' || proposal.status === 'APPROVED') return true;
    if (proposal.status === 'PROPOSED' && proposal.riskLevel === 'LOW') return gateway.approveProposal(proposal.id);
    return false;
  }
}
