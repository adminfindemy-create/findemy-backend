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
  /** Cheapest monthly fee must be ≤ this (paise). */
  max_monthly_paise?: number;
  /** Learner age bracket — keep academies with an active batch whose age range overlaps it. */
  age_min?: number;
  age_max?: number;
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
    ageMin: query.age_min,
    ageMax: query.age_max,
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

  // An academy whose fees are unknown (no batches, so `monthly_from_paise` is null) is dropped
  // by a budget filter rather than kept: "under ₹2,000" must not return a listing whose price
  // nobody can see.
  if (query.max_monthly_paise != null) {
    items = items.filter(
      (i) => i.monthly_from_paise != null && i.monthly_from_paise <= query.max_monthly_paise!,
    );
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

/**
 * How many discoverable academies teach each art form. Counted over `categories` (everything a
 * branch teaches), the same match `listAcademies` uses, so a tile's count agrees with the list it
 * opens. Radius applies only when a location is given.
 */
export async function getCategoryCounts(query: { lat?: number; lng?: number; radius_km?: number }) {
  const rows = await repo.findDiscoverableCategories();
  const hasLocation = query.lat != null && query.lng != null;
  const counts: Record<Category, number> = { music: 0, dance: 0, arts: 0, yoga: 0 };
  for (const r of rows) {
    if (hasLocation && query.radius_km) {
      if (r.lat == null || r.lng == null) continue;
      if (haversine(query.lat!, query.lng!, r.lat, r.lng) > query.radius_km) continue;
    }
    // Union with the primary, matching listAcademies — `categories` can be empty on older rows.
    for (const c of new Set([r.category, ...r.categories])) counts[c as Category] += 1;
  }
  return { counts };
}

export async function getAcademyById(id: string, userId?: string) {
  const academy = await repo.findAcademyById(id);
  if (!academy) throw new AppError('NOT_FOUND', 404, 'Academy not found');

  // Whether THIS student may review THIS academy, resolved server-side so the client does not
  // have to re-derive the rule from three other endpoints. Mirrors `reviews.createReview`
  // exactly — an attended trial, or an enrolment in one of this academy's batches — and
  // reports the review they already left, since only one per academy is allowed.
  const reviewContext = userId
    ? await repo.findReviewContext(id, userId)
    : { myReview: null, trial: null, enrollment: null };

  // Sibling branches of the same brand ("Other locations"), and the brand-wide rating used
  // only as copy on a branch that has no reviews of its own yet.
  const [siblings, groupRating] = await Promise.all([
    repo.findSiblingBranches(academy.groupId, academy.id),
    repo.findGroupRating(academy.groupId),
  ]);

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
      // What the academy says it is known for. It reached the studio read but never this one,
      // so the field an owner fills in on their profile screen could not be shown to a learner.
      specialities: academy.specialities,
      // Keys from the AMENITIES catalogue; the client owns the label + glyph so retiring one
      // never needs a deploy on both sides at once.
      amenities: academy.amenities,
      images: academy.images,
      created_at: academy.createdAt.toISOString(),
      // Brand identity. A branch card reads "XYZ Academy — Andheri (2.1 km)", so the client
      // needs the brand name and the location label separately from the composed `name`.
      group_id: academy.groupId,
      group_name: academy.group.name,
      branch_label: academy.branchLabel,
    },
    // Other locations of the same brand. Empty for a single-branch academy.
    other_branches: siblings.map((b) => ({
      id: b.id,
      name: b.name,
      branch_label: b.branchLabel,
      address: b.address,
      lat: b.lat,
      lng: b.lng,
      rating: b.rating,
      rating_count: b.ratingCount,
      images: b.images,
    })),
    // Context for a brand-new location: "New location · XYZ Academy rated 4.6★ across 3
    // branches". `Academy.rating` itself stays honest (0) so discovery can't sort this
    // branch as if it were proven.
    group_rating:
      academy.ratingCount === 0 && groupRating.rating_count > 0
        ? { ...groupRating, group_name: academy.group.name }
        : null,
    coaches: academy.group.coaches.map((c) => ({
      id: c.id,
      // The branch being viewed — a coach is brand-level, but this read is branch-scoped
      // (only coaches with an active batch here are included).
      academy_id: academy.id,
      name: c.name,
      specialty: c.specialty,
      bio: c.bio,
      // Experience & qualifications, and the photo. Both are new to this payload: a teacher now
      // writes their own profile, and a field a learner never sees is a field not worth asking
      // for. `phone` left for the same reason in reverse — it was reaching logged-in students.
      credentials: c.credentials,
      avatar_url: c.avatarUrl ?? null,
      created_at: c.createdAt.toISOString(),
    })),
    // Flat batch list (kept for back-compat during the programs migration).
    batches: batchesWire,
    // Programs with nested batches. A program is surfaced only if it has ≥1 active batch
    // (empty programs are academy-only). Ordered by title for a stable catalog.
    programs: academy.group.programs
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
      comment: r.commentHidden ? null : r.comment,
      response: r.responseHidden ? null : r.response,
      responded_at: r.respondedAt?.toISOString() ?? null,
      created_at: r.createdAt.toISOString(),
      edited_at: r.editedAt?.toISOString() ?? null,
      user_name: r.user.name,
      user_avatar_initial: r.user.avatarInitial,
    })),
    // The review already left here, so the client can offer "delete" instead of "write".
    my_review: reviewContext.myReview
      ? {
          id: reviewContext.myReview.id,
          rating: reviewContext.myReview.rating,
          comment: reviewContext.myReview.comment,
          created_at: reviewContext.myReview.createdAt.toISOString(),
          edited_at: reviewContext.myReview.editedAt?.toISOString() ?? null,
        }
      : null,
    // `source` carries the ids the create call needs, so the client can route straight to the
    // review screen with no further lookup. A trial is preferred when both exist: it pins a
    // single batch, and it is the more specific claim of the two.
    review_eligibility: {
      can_review: !reviewContext.myReview && !!(reviewContext.trial ?? reviewContext.enrollment),
      source: reviewContext.trial ? 'trial' : reviewContext.enrollment ? 'enrollment' : null,
      trial_id: reviewContext.trial?.id ?? null,
      batch_id: reviewContext.trial?.batchId ?? reviewContext.enrollment?.batchId ?? null,
    },
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
      comment: r.commentHidden ? null : r.comment,
      response: r.responseHidden ? null : r.response,
      responded_at: r.respondedAt?.toISOString() ?? null,
      created_at: r.createdAt.toISOString(),
      edited_at: r.editedAt?.toISOString() ?? null,
      user_name: r.user.name,
      user_avatar_initial: r.user.avatarInitial,
    })),
    next_cursor: nextCursor,
  };
}
