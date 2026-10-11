import type { Category } from '@prisma/client';
import * as repo from './repo.js';

/**
 * Search-as-you-type suggestions.
 *
 * One endpoint rather than three client-side calls: the panel has to RANK across kinds (an exact
 * academy-name hit belongs above a loose program-description match), and ranking cannot be done
 * by a client holding three unrelated result sets.
 *
 * Every item carries a `route`, so the panel stays a dumb list — it does not need to know how a
 * program differs from a workshop in order to open one.
 */

const CATEGORIES: { key: Category; label: string; synonyms: string[] }[] = [
  { key: 'music', label: 'Music', synonyms: ['music', 'guitar', 'piano', 'vocal', 'singing', 'tabla', 'sitar', 'drums'] },
  { key: 'dance', label: 'Dance', synonyms: ['dance', 'dancing', 'bharatanatyam', 'kathak', 'hip hop', 'hiphop', 'salsa', 'bollywood'] },
  { key: 'arts', label: 'Arts', synonyms: ['art', 'arts', 'painting', 'sketch', 'sketching', 'drawing', 'pottery', 'craft'] },
  { key: 'yoga', label: 'Yoga', synonyms: ['yoga', 'meditation', 'breathwork', 'pranayama', 'wellness'] },
];

export type Suggestion = {
  kind: 'academy' | 'program' | 'workshop' | 'category';
  id: string;
  label: string;
  sublabel: string | null;
  category: string | null;
  /** Where tapping it goes. A category has no detail screen — the client filters instead. */
  route: string | null;
  image: string | null;
};

/**
 * Rank: an exact match first, then a prefix match, then anything else. Within a tier the order
 * the repo returned (rating for academies, start date for workshops) is preserved, so the
 * comparator is stable.
 */
function matchTier(label: string, q: string): number {
  const l = label.toLowerCase();
  const needle = q.toLowerCase();
  if (l === needle) return 0;
  if (l.startsWith(needle)) return 1;
  // A word-boundary hit ("Guitar" in "Fingerstyle Guitar Masterclass") beats a mid-word one.
  if (new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(l)) return 2;
  return 3;
}

export async function suggest({ q, limit = 8 }: { q: string; limit?: number }) {
  const query = q.trim();
  // One character matches nearly everything, which is noise rather than a suggestion. The client
  // does not call below two either; this is the server refusing to do the expensive thing.
  if (query.length < 2) return { items: [] as Suggestion[] };

  const perKind = Math.max(3, Math.ceil(limit / 2));
  const [academies, programs, workshops] = await Promise.all([
    repo.suggestAcademies(query, perKind),
    repo.suggestPrograms(query, perKind),
    repo.suggestWorkshops(query, perKind),
  ]);

  const items: Suggestion[] = [];

  for (const a of academies) {
    items.push({
      kind: 'academy',
      id: a.id,
      label: a.name,
      sublabel: [capitalise(a.category), a.branchLabel ?? a.address].filter(Boolean).join(' · ') || null,
      category: a.category,
      route: `/academy/${a.id}`,
      image: a.images?.[0] ?? null,
    });
  }

  for (const p of programs) {
    const academy = p.batches[0]?.academy;
    items.push({
      kind: 'program',
      id: p.id,
      label: p.title,
      sublabel: [academy?.name, p.level].filter(Boolean).join(' · ') || null,
      category: p.category,
      route: `/program/${p.id}`,
      image: p.media[0]?.url ?? null,
    });
  }

  for (const w of workshops) {
    items.push({
      kind: 'workshop',
      id: w.id,
      label: w.title,
      sublabel: [w.academy?.name, formatDay(w.startAt)].filter(Boolean).join(' · ') || null,
      category: w.category,
      route: `/workshop/${w.id}`,
      image: w.coverImageUrl ?? null,
    });
  }

  // An art form the words point at — "guitar" should offer "Browse Music" even when no academy
  // happens to have Guitar in its NAME. This is the suggestion that rescues a search that would
  // otherwise come back empty.
  const cat = CATEGORIES.find((c) => c.synonyms.some((sy) => sy.startsWith(query.toLowerCase()) || query.toLowerCase().startsWith(sy)));
  if (cat && !items.some((i) => i.kind === 'category')) {
    const count = await repo.countAcademiesByCategory(cat.key);
    if (count > 0) {
      items.push({
        kind: 'category',
        id: cat.key,
        label: `${cat.label} academies`,
        sublabel: `${count} near you`,
        category: cat.key,
        route: null,
        image: null,
      });
    }
  }

  const ranked = items
    .map((item, i) => ({ item, tier: matchTier(item.label, query), i }))
    .sort((a, b) => a.tier - b.tier || a.i - b.i)
    .slice(0, limit)
    .map((r) => r.item);

  return { items: ranked };
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatDay(d: Date): string {
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
}

// ─── The empty search screen ─────────────────────────────────────────────────

export type TrendingResponse = {
  /** Tappable words, not results — they go back into the search box. */
  trending_searches: string[];
  /** What students near you are booking and saving right now. */
  trending_academies: Suggestion[];
  /** Chosen from the art forms this student picked at onboarding. Empty if they picked none. */
  for_you: Suggestion[];
  /** The heading the client shows over `trending_academies`, e.g. "Trending in Delhi-NCR". */
  city_label: string | null;
};

/**
 * What the search screen shows BEFORE anything is typed.
 *
 * Everything here is derived from real rows — bookings, saves, the catalogue, and the student's
 * own stated interests. Nothing is curated by hand, so it stays true as the catalogue grows and
 * there is no editorial list to go stale.
 *
 * `userId` is OPTIONAL: the public web has no signed-in visitor, so there are no interests to
 * personalise with and no saved location to name. Everything else — what is trending, what is
 * being taught most — is the same for everyone, and the "for you" rail degrades to the same
 * category floor a brand-new account gets.
 */
export async function trending({ userId }: { userId?: string }): Promise<TrendingResponse> {
  const { interests, location } = userId
    ? await repo.userInterests(userId)
    : { interests: [] as Category[], location: null };

  const [rankedIds, programTitles, forYouRows] = await Promise.all([
    repo.trendingAcademyIds(6),
    repo.trendingProgramTitles(8, interests.length ? interests : undefined),
    repo.academiesForCategories(interests, 6),
  ]);

  const trendingAcademies = await repo.academiesByIds(rankedIds);

  // Terms: the programs being taught most, then the art forms themselves as a floor — a brand
  // new deployment with no catalogue still shows something tappable.
  const titles = programTitles.map((p) => p.title);
  const categoryWords = (interests.length ? interests : CATEGORIES.map((c) => c.key)).map(
    (c) => CATEGORIES.find((x) => x.key === c)?.label ?? c,
  );
  const trendingSearches = dedupe([...titles, ...categoryWords]).slice(0, 8);

  return {
    trending_searches: trendingSearches,
    trending_academies: trendingAcademies.map(academySuggestion),
    // Never repeat a card the trending row already showed — two identical tiles on one screen
    // reads as a bug, not a recommendation.
    for_you: forYouRows
      .filter((a) => !trendingAcademies.some((t) => t.id === a.id))
      .slice(0, 4)
      .map(academySuggestion),
    city_label: location,
  };
}

type AcademyRow = {
  id: string;
  name: string;
  branchLabel: string | null;
  category: string;
  address: string;
  images: string[];
};

function academySuggestion(a: AcademyRow): Suggestion {
  return {
    kind: 'academy',
    id: a.id,
    label: a.name,
    sublabel: [capitalise(a.category), a.branchLabel ?? a.address].filter(Boolean).join(' · ') || null,
    category: a.category,
    route: `/academy/${a.id}`,
    image: a.images?.[0] ?? null,
  };
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const k = v.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
