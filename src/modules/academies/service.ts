import { AppError } from '../../lib/app-error.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { toBatchWire, toProgramWire } from '../programs/wire.js';
import * as repo from './repo.js';

type Category = 'music' | 'dance' | 'arts' | 'yoga';

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(v: number) {
  return (v * Math.PI) / 180;
}

export async function listAcademies(query: {
  q?: string;
  category?: Category;
  lat?: number;
  lng?: number;
  radius_km?: number;
  online?: boolean;
  min_rating?: number;
  sort?: 'rating' | 'distance' | 'top_rated';
  cursor?: string;
  limit?: number;
}) {
  const limit = Math.min(query.limit ?? 20, 50);
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
  const hasLocation = query.lat != null && query.lng != null;

  const rows = await repo.searchAcademies({
    q: query.q,
    category: query.category,
    online: query.online,
    sort: query.sort,
    limit,
    cursor: cursor ?? undefined,
  });

  let items = rows.map((r) => ({
    id: r.id,
    name: r.name,
    category: r.category,
    address: r.address,
    lat: r.lat,
    lng: r.lng,
    verified: r.verified,
    online_available: r.onlineAvailable,
    rating: r.rating,
    rating_count: r.ratingCount,
    bio: r.bio,
    images: r.images,
    // "Trial from" = cheapest trial across the academy's batches (null if none).
    trial_from_paise: r.batches.length ? Math.min(...r.batches.map((b) => b.trialFeePaise)) : null,
    monthly_from_paise: r.batches.length ? Math.min(...r.batches.map((b) => b.monthlyFeePaise)) : null,
    created_at: r.createdAt.toISOString(),
    distance_km: hasLocation
      ? // r.lat/r.lng are Float? in Prisma; at runtime null coerces to 0 in the
        // haversine arithmetic, so `?? 0` is behavior-equivalent.
        haversine(query.lat!, query.lng!, r.lat ?? 0, r.lng ?? 0)
      : null,
  }));

  if (hasLocation && query.radius_km) {
    items = items.filter((i) => (i.distance_km ?? Infinity) <= query.radius_km!);
  }

  if (query.min_rating) {
    items = items.filter((i) => i.rating >= query.min_rating!);
  }

  if (query.sort === 'distance' && hasLocation) {
    items.sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity));
  } else if (query.sort === 'top_rated') {
    items.sort((a, b) => b.rating * Math.log(b.rating_count + 1) - a.rating * Math.log(a.rating_count + 1));
  }

  const hasMore = items.length > limit;
  const pageItems = items.slice(0, limit);

  const nextCursor =
    hasMore && pageItems.length > 0
      ? encodeCursor({
          id: pageItems[pageItems.length - 1].id,
          ts: pageItems[pageItems.length - 1].created_at,
        })
      : null;

  return {
    items: pageItems,
    next_cursor: nextCursor,
  };
}

export async function getAcademyById(id: string) {
  const academy = await repo.findAcademyById(id);
  if (!academy) throw new AppError('NOT_FOUND', 404, 'Academy not found');

  // Map batches once, then group by program so programs and the flat list share the shape.
  const batchesWire = academy.batches.map(toBatchWire);
  const batchesByProgram = new Map<string, typeof batchesWire>();
  for (const b of batchesWire) {
    const list = batchesByProgram.get(b.program_id) ?? [];
    list.push(b);
    batchesByProgram.set(b.program_id, list);
  }

  return {
    academy: {
      id: academy.id,
      name: academy.name,
      category: academy.category,
      address: academy.address,
      lat: academy.lat,
      lng: academy.lng,
      verified: academy.verified,
      online_available: academy.onlineAvailable,
      rating: academy.rating,
      rating_count: academy.ratingCount,
      bio: academy.bio,
      tagline: academy.tagline,
      modes_offered: academy.modesOffered,
      images: academy.images,
      created_at: academy.createdAt.toISOString(),
    },
    coaches: academy.coaches.map((c) => ({
      id: c.id,
      academy_id: c.academyId,
      name: c.name,
      specialty: c.specialty,
      bio: c.bio,
      phone: c.phone,
      created_at: c.createdAt.toISOString(),
    })),
    // Flat batch list (kept for back-compat during the programs migration).
    batches: batchesWire,
    // Programs with nested batches. A program is surfaced only if it has ≥1 active batch
    // (empty programs are academy-only). Ordered by title for a stable catalog.
    programs: academy.programs
      .map((p) => toProgramWire(p, batchesByProgram.get(p.id) ?? []))
      .filter((p) => p.batches.length > 0)
      .sort((a, b) => a.title.localeCompare(b.title)),
    reviews: academy.reviews.map((r) => ({
      id: r.id,
      user_id: r.userId,
      academy_id: r.academyId,
      batch_id: r.batchId,
      trial_id: r.trialId,
      rating: r.rating,
      comment: r.comment,
      response: r.response,
      responded_at: r.respondedAt?.toISOString() ?? null,
      created_at: r.createdAt.toISOString(),
      user_name: r.user.name,
      user_avatar_initial: r.user.avatarInitial,
    })),
  };
}

export async function getAcademyReviews(
  academyId: string,
  cursor?: string,
  limit = 20,
) {
  const decoded = cursor ? decodeCursor(cursor) : undefined;
  const reviews = await repo.findAcademyReviews(
    academyId,
    decoded ?? undefined,
    limit,
  );

  const hasMore = reviews.length > limit;
  const items = reviews.slice(0, limit);

  const nextCursor =
    hasMore && items.length > 0
      ? encodeCursor({
          id: items[items.length - 1].id,
          ts: items[items.length - 1].createdAt.toISOString(),
        })
      : null;

  return {
    items: items.map((r) => ({
      id: r.id,
      user_id: r.userId,
      academy_id: r.academyId,
      batch_id: r.batchId,
      trial_id: r.trialId,
      rating: r.rating,
      comment: r.comment,
      response: r.response,
      responded_at: r.respondedAt?.toISOString() ?? null,
      created_at: r.createdAt.toISOString(),
      user_name: r.user.name,
      user_avatar_initial: r.user.avatarInitial,
    })),
    next_cursor: nextCursor,
  };
}
