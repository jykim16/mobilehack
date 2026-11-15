import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { CACHE_TTL_MS, SINGLE_FLIGHT_MS, type CacheKind } from "./lib/cache";

const kind = v.union(
  v.literal("offer"),
  v.literal("comparison"),
  v.literal("query"),
  v.literal("reddit"),
);

const rowView = {
  key: v.string(),
  payload: v.union(v.string(), v.null()),
  fetchedAt: v.number(),
  source: v.string(),
  simulated: v.boolean(),
  attempts: v.number(),
  pendingStartedAt: v.union(v.number(), v.null()),
  invalidatedAt: v.union(v.number(), v.null()),
  error: v.union(v.string(), v.null()),
};

export const read = internalQuery({
  returns: v.union(v.null(), v.object(rowView)),
  args: { kind, key: v.string() },
  handler: async (ctx, { kind: k, key }) => {
    const row = await ctx.db
      .query("extractionCache")
      .withIndex("by_kind_and_key", (q) => q.eq("kind", k).eq("key", key))
      .unique();
    if (!row) return null;
    return {
      key: row.key,
      payload: row.payload ?? null,
      fetchedAt: row.fetchedAt,
      source: row.source,
      simulated: row.simulated,
      attempts: row.attempts,
      pendingStartedAt: row.pendingStartedAt ?? null,
      invalidatedAt: row.invalidatedAt ?? null,
      error: row.error ?? null,
    };
  },
});

export const isFresh = (kindName: CacheKind, fetchedAt: number, now = Date.now()) =>
  fetchedAt > 0 && now - fetchedAt < CACHE_TTL_MS[kindName];

/** A lock only blocks inside its window; an older one is treated as abandoned. */
export const lockIsLive = (pendingStartedAt: number | null, now = Date.now()) =>
  pendingStartedAt !== null && now - pendingStartedAt < SINGLE_FLIGHT_MS;

/**
 * Single flight: one caller wins the right to call upstream for this key, and the
 * duplicates attach to the result it stores. A lock older than the window is
 * treated as abandoned so one crashed attempt cannot wedge the key.
 */
export const claim = internalMutation({
  returns: v.object({ claimed: v.boolean(), token: v.union(v.string(), v.null()) }),
  args: { kind, key: v.string(), source: v.string() },
  handler: async (ctx, { kind: k, key, source }) => {
    const now = Date.now();
    const token = crypto.randomUUID();
    const row = await ctx.db
      .query("extractionCache")
      .withIndex("by_kind_and_key", (q) => q.eq("kind", k).eq("key", key))
      .unique();
    if (row) {
      if (row.pendingStartedAt && now - row.pendingStartedAt < SINGLE_FLIGHT_MS) {
        return { claimed: false, token: null };
      }
      await ctx.db.patch("extractionCache", row._id, {
        pendingStartedAt: now,
        pendingToken: token,
        source,
      });
      return { claimed: true, token };
    }
    await ctx.db.insert("extractionCache", {
      kind: k,
      key,
      payload: undefined,
      fetchedAt: 0,
      source,
      simulated: false,
      attempts: 0,
      pendingStartedAt: now,
      pendingToken: token,
      lastAttemptAt: now,
      error: undefined,
    });
    return { claimed: true, token };
  },
});

export const finish = internalMutation({
  returns: v.null(),
  args: {
    kind,
    key: v.string(),
    payload: v.string(),
    source: v.string(),
    simulated: v.boolean(),
    token: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { kind: k, key, payload, source, simulated, token }) => {
    const now = Date.now();
    const row = await ctx.db
      .query("extractionCache")
      .withIndex("by_kind_and_key", (q) => q.eq("kind", k).eq("key", key))
      .unique();
    // A run that lost its lock must not overwrite what the run holding it wrote.
    if (row && token !== null && row.pendingToken && row.pendingToken !== token) return null;
    if (!row) {
      await ctx.db.insert("extractionCache", {
        kind: k,
        key,
        payload,
        fetchedAt: now,
        source,
        simulated,
        attempts: 1,
        lastAttemptAt: now,
      });
      return null;
    }
    await ctx.db.patch("extractionCache", row._id, {
      payload,
      fetchedAt: now,
      source,
      simulated,
      attempts: row.attempts + 1,
      lastAttemptAt: now,
      pendingStartedAt: undefined,
      pendingToken: undefined,
      invalidatedAt: undefined,
      error: undefined,
    });
    return null;
  },
});

/** A failed attempt is recorded, never cached as an answer: the next call retries. */
export const fail = internalMutation({
  returns: v.null(),
  args: { kind, key: v.string(), error: v.string(), token: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { kind: k, key, error, token }) => {
    const now = Date.now();
    const row = await ctx.db
      .query("extractionCache")
      .withIndex("by_kind_and_key", (q) => q.eq("kind", k).eq("key", key))
      .unique();
    if (row && token && row.pendingToken && row.pendingToken !== token) return null;
    if (!row) {
      await ctx.db.insert("extractionCache", {
        kind: k,
        key,
        fetchedAt: 0,
        source: "none",
        simulated: false,
        attempts: 1,
        lastAttemptAt: now,
        error,
      });
      return null;
    }
    await ctx.db.patch("extractionCache", row._id, {
      attempts: row.attempts + 1,
      lastAttemptAt: now,
      pendingStartedAt: undefined,
      pendingToken: undefined,
      error,
    });
    return null;
  },
});

/**
 * Forces the next read upstream while keeping the payload and the moment it was
 * really read, so a refusal can still serve it with an honest date.
 */
export const invalidate = internalMutation({
  returns: v.null(),
  args: { kind, key: v.string() },
  handler: async (ctx, { kind: k, key }) => {
    const row = await ctx.db
      .query("extractionCache")
      .withIndex("by_kind_and_key", (q) => q.eq("kind", k).eq("key", key))
      .unique();
    if (!row) return null;
    // Leaves the lock alone: a run that is in flight still owns the write, and
    // clearing the lock here would let a second run race it.
    await ctx.db.patch("extractionCache", row._id, { invalidatedAt: Date.now() });
    return null;
  },
});
