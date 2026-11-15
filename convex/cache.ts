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
  pending: v.boolean(),
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
      pending: Boolean(row.pendingStartedAt && Date.now() - row.pendingStartedAt < SINGLE_FLIGHT_MS),
      error: row.error ?? null,
    };
  },
});

export const isFresh = (kindName: CacheKind, fetchedAt: number, now = Date.now()) =>
  fetchedAt > 0 && now - fetchedAt < CACHE_TTL_MS[kindName];

/**
 * Single flight: one caller wins the right to call upstream for this key, and the
 * duplicates attach to the result it stores. A lock older than the window is
 * treated as abandoned so one crashed attempt cannot wedge the key.
 */
export const claim = internalMutation({
  returns: v.object({ claimed: v.boolean() }),
  args: { kind, key: v.string(), source: v.string() },
  handler: async (ctx, { kind: k, key, source }) => {
    const now = Date.now();
    const row = await ctx.db
      .query("extractionCache")
      .withIndex("by_kind_and_key", (q) => q.eq("kind", k).eq("key", key))
      .unique();
    if (row) {
      if (row.pendingStartedAt && now - row.pendingStartedAt < SINGLE_FLIGHT_MS) {
        return { claimed: false };
      }
      await ctx.db.patch("extractionCache", row._id, { pendingStartedAt: now, source });
      return { claimed: true };
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
      lastAttemptAt: now,
      error: undefined,
    });
    return { claimed: true };
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
  },
  handler: async (ctx, { kind: k, key, payload, source, simulated }) => {
    const now = Date.now();
    const row = await ctx.db
      .query("extractionCache")
      .withIndex("by_kind_and_key", (q) => q.eq("kind", k).eq("key", key))
      .unique();
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
      error: undefined,
    });
    return null;
  },
});

/** A failed attempt is recorded, never cached as an answer: the next call retries. */
export const fail = internalMutation({
  returns: v.null(),
  args: { kind, key: v.string(), error: v.string() },
  handler: async (ctx, { kind: k, key, error }) => {
    const now = Date.now();
    const row = await ctx.db
      .query("extractionCache")
      .withIndex("by_kind_and_key", (q) => q.eq("kind", k).eq("key", key))
      .unique();
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
      error,
    });
    return null;
  },
});

/** Keeps the payload for a stale fallback but forces the next read to go upstream. */
export const invalidate = internalMutation({
  returns: v.null(),
  args: { kind, key: v.string() },
  handler: async (ctx, { kind: k, key }) => {
    const row = await ctx.db
      .query("extractionCache")
      .withIndex("by_kind_and_key", (q) => q.eq("kind", k).eq("key", key))
      .unique();
    if (!row) return null;
    await ctx.db.patch("extractionCache", row._id, { fetchedAt: 0, pendingStartedAt: undefined });
    return null;
  },
});
