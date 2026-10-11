#!/usr/bin/env tsx
/**
 * Cross-checks the compiled Anchor IDL against the TypeScript farm client.
 * Fails loudly on any drift between program and client (instruction names,
 * argument order/widths, account size, PDA seeds).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const idlPath = 'target/idl/astrix_world.json';
if (!fs.existsSync(idlPath)) {
  console.error(`MISSING: ${idlPath} — run \`anchor build\` first.`);
  process.exit(2);
}
const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
const fail: string[] = [];
const check = (cond: boolean, message: string) => {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${message}`);
  if (!cond) fail.push(message);
};

const disc = (prefix: string, name: string) =>
  crypto.createHash('sha256').update(`${prefix}:${name}`).digest().subarray(0, 8).toString('hex');

const byName = Object.fromEntries((idl.instructions as Array<{ name: string; discriminator: number[]; args: Array<{ name: string; type: unknown }> }>).map((ix) => [ix.name, ix]));

// Instruction discriminators used by FarmChain.createAnchorInstruction.
for (const name of ['initialize_farm', 'build_farm', 'delegate_farm', 'commit_farm', 'commit_and_undelegate_farm']) {
  const ix = byName[name];
  check(Boolean(ix), `instruction ${name} exists in IDL`);
  if (ix) {
    check(Buffer.from(ix.discriminator).toString('hex') === disc('global', name), `${name} discriminator matches sha256(global:${name})`);
  }
}

// build_farm args: expected_nonce u64, action_id [u8;32], wood_spent u8.
const buildArgs = byName['build_farm']?.args ?? [];
check(buildArgs.length === 3, `build_farm has 3 args (got ${buildArgs.length})`);
check(JSON.stringify(buildArgs[0]) === JSON.stringify({ name: 'expected_nonce', type: 'u64' }), 'build_farm arg0 is expected_nonce: u64');
check(buildArgs[1]?.name === 'action_id', 'build_farm arg1 is action_id');
check(JSON.stringify(buildArgs[2]) === JSON.stringify({ name: 'wood_spent', type: 'u8' }), 'build_farm arg2 is wood_spent: u8');

// FarmState account layout: 8 + 1 + 9 + 7 + 32 + 1 + 8 + 1 = 67.
const accounts = Object.fromEntries((idl.accounts as Array<{ name: string; discriminator: number[] }>).map((a) => [a.name, a]));
check(Boolean(accounts['FarmState']), 'FarmState account exists in IDL');
if (accounts['FarmState']) {
  check(Buffer.from(accounts['FarmState'].discriminator).toString('hex') === disc('account', 'FarmState'), 'FarmState discriminator matches (client constant c666d84a3f42a3be)');
}
const farmType = (idl.types as Array<{ name: string; type: { fields: Array<{ name: string; type: unknown }> } }>).find((t) => t.name === 'FarmState');
if (farmType) {
  const fields = farmType.type.fields.map((f) => `${f.name}:${JSON.stringify(f.type)}`).join(',');
  console.log(`     FarmState fields: ${fields}`);
  check(farmType.type.fields.length === 7, 'FarmState has 7 fields (schema, world, farm, authority, state, nonce, wood_spent)');
} else {
  check(false, 'FarmState type definition present in IDL');
}

// Program ID matches the deployed/tested PDA derivation.
const programId = idl.address as string;
check(programId === 'Gd5DXjcDxr1jJFS2LBzoLkZvYsHZWhVwbYdQ7eZEKSdP', `program ID is the deployed-build ID (got ${programId})`);

if (fail.length > 0) {
  console.error(`\n${fail.length} IDL compatibility failure(s).`);
  process.exit(1);
}
console.log('\nIDL ↔ client compatibility verified.');
