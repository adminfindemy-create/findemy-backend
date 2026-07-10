import { AppError } from '../../lib/app-error.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { toBatchWire, toProgramWire } from '../programs/wire.js';
import * as repo from './repo.js';

type Category = 'music' | 'dance' | 'arts' | 'yoga';

// Great-circle distance between two lat/lng points, in kilometers.
function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const earthRadiusKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

function toRad(degrees: number) {
  return (degrees * Math.PI) / 180;
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

  const academyRows = await repo.searchAcademies({
    q: query.q,
    category: query.category,
    online: query.online,
    sort: query.sort,
    limit,
    cursor: cursor ?? undefined,
  });

  let items = academyRows.map((academy) => ({
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
    images: academy.images,
    // "Trial from" = cheapest trial across the academy's batches (null if none).
    trial_from_paise: academy.batches.length ? Math.min(...academy.batches.map((batch) => batch.trialFeePaise)) : null,
    monthly_from_paise: academy.batches.length ? Math.min(...academy.batches.map((batch) => batch.monthlyFeePaise)) : null,
    created_at: academy.createdAt.toISOString(),
    distance_km: hasLocation
      ? // academy.lat/lng are Float? in Prisma; at runtime null coerces to 0 in the
        // haversine arithmetic, so `?? 0` is behavior-equivalent.
        haversine(query.lat!, query.lng!, academy.lat ?? 0, academy.lng ?? 0)
      : null,
  }));

  if (hasLocation && query.radius_km) {
    items = items.filter((item) => (item.distance_km ?? Infinity) <= query.radius_km!);
  }

  if (query.min_rating) {
    items = items.filter((item) => item.rating >= query.min_rating!);
  }

  if (query.sort === 'distance' && hasLocation) {
    items.sort((itemA, itemB) => (itemA.distance_km ?? Infinity) - (itemB.distance_km ?? Infinity));
  } else if (query.sort === 'top_rated') {
    // Bayesian-ish blend: weight rating by log(review count) so a 5★/1-review academy
    // doesn't outrank a 4.8★/500-review one.
    items.sort(
      (itemA, itemB) =>
        itemB.rating * Math.log(itemB.rating_count + 1) - itemA.rating * Math.log(itemA.rating_count + 1),
    );
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
  for (const batch of batchesWire) {
    const programBatches = batchesByProgram.get(batch.program_id) ?? [];
    programBatches.push(batch);
    batchesByProgram.set(batch.program_id, programBatches);
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
    coaches: academy.coaches.map((coach) => ({
      id: coach.id,
      academy_id: coach.academyId,
      name: coach.name,
      specialty: coach.specialty,
      bio: coach.bio,
      phone: coach.phone,
      created_at: coach.createdAt.toISOString(),
    })),
    // Flat batch list (kept for back-compat during the programs migration).
    batches: batchesWire,
    // Programs with nested batches. A program is surfaced only if it has ≥1 active batch
    // (empty programs are academy-only). Ordered by title for a stable catalog.
    programs: academy.programs
      .map((program) => toProgramWire(program, batchesByProgram.get(program.id) ?? []))
      .filter((program) => program.batches.length > 0)
      .sort((programA, programB) => programA.title.localeCompare(programB.title)),
    reviews: academy.reviews.map((review) => ({
      id: review.id,
      user_id: review.userId,
      academy_id: review.academyId,
      batch_id: review.batchId,
      trial_id: review.trialId,
      rating: review.rating,
      comment: review.comment,
      response: review.response,
      responded_at: review.respondedAt?.toISOString() ?? null,
      created_at: review.createdAt.toISOString(),
      user_name: review.user.name,
      user_avatar_initial: review.user.avatarInitial,
    })),
  };
}

export async function getAcademyReviews(
  academyId: string,
  cursor?: string,
  limit = 20,
) {
  const decodedCursor = cursor ? decodeCursor(cursor) : undefined;
  const reviews = await repo.findAcademyReviews(
    academyId,
    decodedCursor ?? undefined,
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
    items: items.map((review) => ({
      id: review.id,
      user_id: review.userId,
      academy_id: review.academyId,
      batch_id: review.batchId,
      trial_id: review.trialId,
      rating: review.rating,
      comment: review.comment,
      response: review.response,
      responded_at: review.respondedAt?.toISOString() ?? null,
      created_at: review.createdAt.toISOString(),
      user_name: review.user.name,
      user_avatar_initial: review.user.avatarInitial,
    })),
    next_cursor: nextCursor,
  };
}
