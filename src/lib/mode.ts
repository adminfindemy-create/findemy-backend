import type { Mode } from '@findemy/types';

// S1.3 / Option A (S0.1): the DB stores BatchMode as `online | offline`, but the wire
// contract is the canonical `Mode` = `'in-studio' | 'online'` (`offline ≡ in-studio`).
// Map at the API boundary in BOTH directions so the apps speak one vocabulary.

export type DbMode = 'online' | 'offline';

export function toWireMode(db: DbMode | string): Mode {
  return db === 'online' ? 'online' : 'in-studio';
}

export function toDbMode(wire: Mode | string): DbMode {
  return wire === 'online' ? 'online' : 'offline';
}
