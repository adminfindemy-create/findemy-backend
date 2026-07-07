import { describe, it, expect } from 'vitest';
import { mockHandlers } from '../mock/fixtures.js';

// The MOCK-mode handlers must honor the request the way the real backend does:
// GET /academies filters by `category` and by `q` (name contains), and
// GET /academies/:id returns the academy matching the route id.
// Regression guard for the "search/filter ignored + every academy opens Raaga"
// bugs (all caused by the handlers ignoring the request).

const call = (key: string, req: unknown) =>
  (mockHandlers as Record<string, (r: unknown) => any>)[key](req);

const RAAGA = '01HX00000000000000000000AC1'; // music
const NRITYANJALI = '01HX00000000000000000000AC2'; // dance

describe('mock GET-academies — list filtering', () => {
  it('returns all academies when no filters are given', async () => {
    const res = await call('GET-academies', { query: {} });
    expect(res.items.length).toBe(4);
  });

  it('filters by category (dance → only dance academies)', async () => {
    const res = await call('GET-academies', { query: { category: 'dance' } });
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items.every((a: { category: string }) => a.category === 'dance')).toBe(true);
  });

  it('filters by search query against the name, case-insensitive', async () => {
    const res = await call('GET-academies', { query: { q: 'yoga' } });
    expect(res.items.length).toBeGreaterThan(0);
    expect(
      res.items.every((a: { name: string }) => a.name.toLowerCase().includes('yoga')),
    ).toBe(true);
  });

  it('returns an empty list when nothing matches', async () => {
    const res = await call('GET-academies', { query: { q: 'zzzznomatch' } });
    expect(res.items).toEqual([]);
  });
});

describe('mock GET-academies-:id — detail is id-aware', () => {
  it('returns the academy matching the route id', async () => {
    const res = await call('GET-academies-_id', { params: { id: NRITYANJALI } });
    expect(res.academy.id).toBe(NRITYANJALI);
    expect(res.academy.name).toBe('Nrityanjali Dance Studio');
    expect(res.academy.category).toBe('dance');
  });

  it('returns the primary fixture academy for its own id', async () => {
    const res = await call('GET-academies-_id', { params: { id: RAAGA } });
    expect(res.academy.id).toBe(RAAGA);
    // S0.4: primary mock-fixture academy renamed Raaga Music Academy → The Rhythm House.
    expect(res.academy.name).toBe('The Rhythm House');
  });
});
