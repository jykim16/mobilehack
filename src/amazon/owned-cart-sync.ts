import type { KeyValueStorageAdapter } from './daemon-engine';

export type OwnedCartSyncStatus = 'pending' | 'syncing' | 'synced' | 'needs_signin' | 'failed' | 'conflict';

export interface OwnedCartItemState {
  itemId: string;
  asin: string;
  url: string;
  title: string;
  variantLabel: string | null;
  desiredQty: number;
  ownedQty: number;
  status: OwnedCartSyncStatus;
  message: string | null;
  updatedAt: number;
}

export type OwnedCartDeltaResult =
  | { kind: 'requires_signin'; reason: string }
  | { kind: 'drift'; liveQty: number; rowCount: number }
  | { kind: 'observed'; liveQty: number; rowCount: number }
  | { kind: 'mutated'; beforeQty: number; afterQty: number | null; error?: string };

export interface OwnedCartDeltaInput {
  asin: string;
  url: string;
  variantLabel: string | null;
  delta: number;
  expectedLiveQty: number | null;
}

export interface OwnedCartSyncEngine {
  applyDelta: (input: OwnedCartDeltaInput) => Promise<OwnedCartDeltaResult>;
  canRun: () => boolean;
}

export interface OwnedCartSyncDeps {
  storage: KeyValueStorageAdapter;
  now?: () => number;
}

export interface AmazonCartSyncValue {
  items: Record<string, OwnedCartItemState>;
  setIntent: (input: OwnedCartIntent) => void;
  retry: (itemId: string) => void;
  dismiss: (itemId: string) => void;
  /** Runs explicit intents still waiting (e.g. when the Cart screen regains focus); never retries failed or conflicted items. */
  resume: () => void;
}

export interface OwnedCartIntent {
  itemId: string;
  asin: string | null;
  url: string;
  title: string;
  variantLabel: string | null;
  quantity: number;
  /** Only an explicit Cart add starts tracking an item; quantity changes and removals act on tracked items. */
  create: boolean;
}

interface AsinRecord {
  expectedLiveQty: number;
  uncertain: { itemId: string; beforeQty: number; delta: number } | null;
}

interface Snapshot {
  items: Record<string, OwnedCartItemState>;
  asins: Record<string, AsinRecord>;
}

const MAX_ITEMS = 25;
const MAX_QTY = 10;
const STORAGE_PREFIX = 'cart_amz_owned_v1_';

export const OWNED_CART_MESSAGES = {
  signIn: 'Sign in to Amazon to sync this item.',
  notApplied: "Amazon didn't update. Tap Retry.",
  unknown: "Couldn't confirm the Amazon cart. Tap Retry to check it again.",
  driftAdd: 'Your Amazon cart changed outside Cart, so Cart stopped syncing this item. Check your Amazon cart.',
  driftRemove: 'Your Amazon cart changed outside Cart, so this item was left in Amazon. Remove it there if you need to.',
  mismatch: "Amazon's cart didn't match what Cart expected, so Cart stopped syncing this item. Check your Amazon cart.",
  forfeited: 'Your Amazon cart changed outside Cart, so this item is no longer synced.',
  unreachable: "Couldn't reach Amazon. Tap Retry.",
  interrupted: "Cart closed before Amazon confirmed the last update, so Cart stopped syncing this item. Check your Amazon cart.",
} as const;

export function ownedCartStorageKey(shopperId: string | null | undefined): string {
  const cleaned = (shopperId ?? 'default').trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  return STORAGE_PREFIX + (cleaned || 'default');
}

function clampQty(quantity: number): number {
  if (!Number.isFinite(quantity)) return 0;
  return Math.max(0, Math.min(MAX_QTY, Math.floor(quantity)));
}

function parseSnapshot(raw: string | null): Snapshot {
  const empty: Snapshot = { items: {}, asins: {} };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as { v?: number; items?: Record<string, OwnedCartItemState>; asins?: Record<string, AsinRecord> };
    if (parsed?.v !== 1 || typeof parsed.items !== 'object' || typeof parsed.asins !== 'object') return empty;
    const items: Record<string, OwnedCartItemState> = {};
    for (const [id, item] of Object.entries(parsed.items ?? {})) {
      if (!item || typeof item.asin !== 'string' || !Number.isInteger(item.ownedQty) || !Number.isInteger(item.desiredQty)) continue;
      items[id] = item;
    }
    const asins = { ...(parsed.asins ?? {}) };
    const interrupted = new Set(Object.values(items).filter((item) => item.status === 'syncing').map((item) => item.asin));
    for (const asin of interrupted) {
      delete asins[asin];
      for (const item of Object.values(items)) {
        if (item.asin !== asin) continue;
        items[item.itemId] = {
          ...item,
          ownedQty: 0,
          status: 'conflict',
          message: item.desiredQty === 0 ? OWNED_CART_MESSAGES.driftRemove : OWNED_CART_MESSAGES.interrupted,
        };
      }
    }
    return { items, asins };
  } catch {
    return empty;
  }
}

/**
 * Cart-owned Amazon basket deltas for explicit user add/remove/quantity actions.
 * Only quantities Cart positively added (verified by a before/after cart read) are ever removed;
 * drift or an unverifiable outcome forfeits ownership for that ASIN instead of guessing.
 */
export class OwnedCartSync {
  private snapshot: Snapshot = { items: {}, asins: {} };
  private key: string | null = null;
  private generation = 0;
  private draining = false;
  private writes: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private readonly now: () => number;
  private engine: OwnedCartSyncEngine | null = null;

  private readonly deps: OwnedCartSyncDeps;

  constructor(deps: OwnedCartSyncDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  setEngine(engine: OwnedCartSyncEngine | null): void {
    this.engine = engine;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getItems = (): Record<string, OwnedCartItemState> => this.snapshot.items;

  get isHydrated(): boolean {
    return this.key !== null;
  }

  async hydrate(shopperId: string | null): Promise<void> {
    const key = ownedCartStorageKey(shopperId);
    if (this.key === key) return;
    const generation = ++this.generation;
    this.key = null;
    this.snapshot = { items: {}, asins: {} };
    this.emit();
    let raw: string | null = null;
    try {
      raw = await this.deps.storage.getItem(key);
    } catch {
      raw = null;
    }
    if (generation !== this.generation) return;
    this.snapshot = parseSnapshot(raw);
    this.key = key;
    this.emit();
  }

  async reset(shopperId: string | null): Promise<void> {
    const previous = this.key;
    this.generation += 1;
    this.key = null;
    this.snapshot = { items: {}, asins: {} };
    this.emit();
    if (previous) {
      const storage = this.deps.storage;
      this.writes = this.writes.then(() => storage.removeItem(previous)).catch(() => undefined);
      await this.writes;
    }
    await this.hydrate(shopperId);
  }

  /** Explicit Cart intent: desired Cart-owned Amazon quantity for this Cart item (0 = removed). */
  setIntent(input: OwnedCartIntent): void {
    if (!this.key) return;
    const desiredQty = clampQty(input.quantity);
    const existing = this.snapshot.items[input.itemId];
    if (!existing) {
      if (!input.create || desiredQty === 0 || !input.asin) return;
      if (Object.keys(this.snapshot.items).length >= MAX_ITEMS) return;
      this.snapshot.items[input.itemId] = {
        itemId: input.itemId,
        asin: input.asin,
        url: input.url,
        title: input.title,
        variantLabel: input.variantLabel,
        desiredQty,
        ownedQty: 0,
        status: 'pending',
        message: null,
        updatedAt: this.now(),
      };
    } else {
      const next: OwnedCartItemState = { ...existing, desiredQty, title: input.title || existing.title, updatedAt: this.now() };
      if (existing.status === 'conflict') {
        if (desiredQty === 0 && existing.ownedQty === 0) next.message = OWNED_CART_MESSAGES.driftRemove;
      } else if (existing.status !== 'syncing' && existing.status !== 'needs_signin') {
        next.status = 'pending';
        next.message = null;
      }
      this.snapshot.items[input.itemId] = next;
    }
    this.commit();
    void this.drain();
  }

  /** Explicit user retry for a failed/conflicted item. */
  retry(itemId: string): void {
    const item = this.snapshot.items[itemId];
    if (!item || item.status === 'syncing') return;
    this.snapshot.items[itemId] = { ...item, status: 'pending', message: null, updatedAt: this.now() };
    this.commit();
    void this.drain();
  }

  dismiss(itemId: string): void {
    const item = this.snapshot.items[itemId];
    if (!item || item.status === 'syncing') return;
    delete this.snapshot.items[itemId];
    this.dropAsinIfUnowned(item.asin);
    this.commit();
  }

  /** Resume intents that were waiting for Amazon sign-in. Never resumes failed/conflict items. */
  resume(): void {
    let changed = false;
    for (const [id, item] of Object.entries(this.snapshot.items)) {
      if (item.status === 'needs_signin') {
        this.snapshot.items[id] = { ...item, status: 'pending', message: null };
        changed = true;
      }
    }
    if (changed) this.commit();
    void this.drain();
  }

  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.key && this.engine?.canRun()) {
        const next = Object.values(this.snapshot.items).find((item) => item.status === 'pending');
        if (!next) return;
        await this.runItem(next.itemId);
      }
    } finally {
      this.draining = false;
    }
  }

  private async runItem(itemId: string): Promise<void> {
    const generation = this.generation;
    const start = this.snapshot.items[itemId];
    if (!start) return;
    this.update(itemId, { status: 'syncing', message: null });
    await this.writes;
    if (generation !== this.generation) return;

    let result: OwnedCartDeltaResult;
    let delta = 0;
    try {
      const reconciled = await this.reconcileUncertain(start.asin, generation);
      if (!reconciled) return;
      const item = this.snapshot.items[itemId];
      if (!item) return;
      if (item.status === 'conflict') return;
      delta = item.desiredQty - item.ownedQty;
      if (delta === 0) {
        this.settleNoop(itemId);
        return;
      }
      const record = this.snapshot.asins[item.asin];
      result = await this.requireEngine().applyDelta({
        asin: item.asin,
        url: item.url,
        variantLabel: item.variantLabel,
        delta,
        expectedLiveQty: record ? record.expectedLiveQty : null,
      });
    } catch {
      if (generation !== this.generation) return;
      this.update(itemId, { status: 'failed', message: OWNED_CART_MESSAGES.unreachable });
      this.dropIfSettled(itemId);
      return;
    }
    if (generation !== this.generation) return;
    this.applyResult(itemId, delta, result);
    this.dropIfSettled(itemId);
  }

  private dropIfSettled(itemId: string): void {
    const item = this.snapshot.items[itemId];
    if (!item || item.status !== 'failed' || item.desiredQty !== item.ownedQty) return;
    if (this.snapshot.asins[item.asin]?.uncertain?.itemId === itemId) return;
    this.settleNoop(itemId);
  }

  private async reconcileUncertain(asin: string, generation: number): Promise<boolean> {
    const record = this.snapshot.asins[asin];
    if (!record?.uncertain) return true;
    const { itemId, beforeQty, delta } = record.uncertain;
    const observed = await this.requireEngine().applyDelta({ asin, url: '', variantLabel: null, delta: 0, expectedLiveQty: null });
    if (generation !== this.generation) return false;
    if (observed.kind === 'requires_signin') {
      for (const item of Object.values(this.snapshot.items)) {
        if (item.asin === asin && item.status === 'syncing') this.update(item.itemId, { status: 'needs_signin', message: OWNED_CART_MESSAGES.signIn });
      }
      return false;
    }
    const liveQty = observed.kind === 'mutated' ? observed.afterQty : observed.liveQty;
    if (liveQty === beforeQty) {
      this.snapshot.asins[asin] = { ...record, uncertain: null };
      if (!this.totalOwned(asin)) delete this.snapshot.asins[asin];
      this.commit();
      return true;
    }
    if (liveQty === beforeQty + delta && this.snapshot.items[itemId]) {
      const owner = this.snapshot.items[itemId];
      this.snapshot.items[itemId] = { ...owner, ownedQty: owner.ownedQty + delta };
      this.snapshot.asins[asin] = { expectedLiveQty: liveQty, uncertain: null };
      if (!this.totalOwned(asin)) delete this.snapshot.asins[asin];
      this.commit();
      return true;
    }
    this.forfeit(asin, OWNED_CART_MESSAGES.mismatch);
    return false;
  }

  private applyResult(itemId: string, delta: number, result: OwnedCartDeltaResult): void {
    const item = this.snapshot.items[itemId];
    if (!item) return;
    switch (result.kind) {
      case 'requires_signin':
        this.update(itemId, { status: 'needs_signin', message: OWNED_CART_MESSAGES.signIn });
        return;
      case 'drift':
        this.forfeit(item.asin, OWNED_CART_MESSAGES.forfeited);
        this.update(itemId, { status: 'conflict', message: delta > 0 ? OWNED_CART_MESSAGES.driftAdd : OWNED_CART_MESSAGES.driftRemove });
        return;
      case 'observed':
        this.update(itemId, { status: 'failed', message: OWNED_CART_MESSAGES.notApplied });
        return;
      case 'mutated': {
        const expectedAfter = result.beforeQty + delta;
        if (result.afterQty === expectedAfter) {
          const ownedQty = item.ownedQty + delta;
          this.snapshot.items[itemId] = { ...item, ownedQty, updatedAt: this.now() };
          if (this.totalOwned(item.asin) > 0) {
            this.snapshot.asins[item.asin] = { expectedLiveQty: result.afterQty, uncertain: null };
          } else {
            delete this.snapshot.asins[item.asin];
          }
          this.settleAfterSuccess(itemId);
          return;
        }
        if (result.afterQty === result.beforeQty) {
          this.update(itemId, { status: 'failed', message: OWNED_CART_MESSAGES.notApplied });
          return;
        }
        if (result.afterQty === null) {
          this.snapshot.asins[item.asin] = {
            expectedLiveQty: this.snapshot.asins[item.asin]?.expectedLiveQty ?? result.beforeQty,
            uncertain: { itemId, beforeQty: result.beforeQty, delta },
          };
          this.update(itemId, { status: 'failed', message: OWNED_CART_MESSAGES.unknown });
          return;
        }
        this.forfeit(item.asin, OWNED_CART_MESSAGES.forfeited);
        this.update(itemId, { status: 'conflict', message: OWNED_CART_MESSAGES.mismatch });
        return;
      }
    }
  }

  private settleAfterSuccess(itemId: string): void {
    const item = this.snapshot.items[itemId];
    if (!item) return;
    if (item.desiredQty !== item.ownedQty) {
      this.update(itemId, { status: 'pending', message: null });
      return;
    }
    this.settleNoop(itemId);
  }

  private settleNoop(itemId: string): void {
    const item = this.snapshot.items[itemId];
    if (!item) return;
    if (item.desiredQty === 0 && item.ownedQty === 0) {
      delete this.snapshot.items[itemId];
      this.dropAsinIfUnowned(item.asin);
      this.commit();
      return;
    }
    this.update(itemId, { status: 'synced', message: null });
  }

  private forfeit(asin: string, message: string): void {
    delete this.snapshot.asins[asin];
    for (const item of Object.values(this.snapshot.items)) {
      if (item.asin !== asin) continue;
      this.snapshot.items[item.itemId] = {
        ...item,
        ownedQty: 0,
        status: 'conflict',
        message: item.desiredQty === 0 ? OWNED_CART_MESSAGES.driftRemove : message,
        updatedAt: this.now(),
      };
    }
    this.commit();
  }

  private requireEngine(): OwnedCartSyncEngine {
    if (!this.engine) throw new Error('Amazon browser is not ready.');
    return this.engine;
  }

  private totalOwned(asin: string): number {
    return Object.values(this.snapshot.items).reduce((sum, item) => sum + (item.asin === asin ? item.ownedQty : 0), 0);
  }

  private dropAsinIfUnowned(asin: string): void {
    const record = this.snapshot.asins[asin];
    if (record && !record.uncertain && this.totalOwned(asin) === 0) delete this.snapshot.asins[asin];
  }

  private update(itemId: string, patch: Partial<OwnedCartItemState>): void {
    const item = this.snapshot.items[itemId];
    if (!item) return;
    this.snapshot.items[itemId] = { ...item, ...patch, updatedAt: this.now() };
    this.commit();
  }

  private commit(): void {
    this.snapshot = { items: { ...this.snapshot.items }, asins: { ...this.snapshot.asins } };
    this.emit();
    const key = this.key;
    if (!key) return;
    const generation = this.generation;
    const payload = JSON.stringify({ v: 1, items: this.snapshot.items, asins: this.snapshot.asins });
    this.writes = this.writes
      .then(() => (generation === this.generation && key === this.key ? this.deps.storage.setItem(key, payload) : undefined))
      .catch(() => undefined);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

