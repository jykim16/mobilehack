export const AMAZON_LIVE_SUBMISSION_ENABLED = false;

export interface DurableSafetyStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

const OWNER_KEY = 'amazon_browser_owner_v1';
let claimTail: Promise<unknown> = Promise.resolve();
let activeBrowserOwner: PersistedBrowserOwner | null = null;

function intentKey(shopperId: string, orderRef: string): string {
  return 'amazon_intent_v1_' + Array.from(JSON.stringify([shopperId, orderRef]))
    .map((char) => char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
}

export class DurableSubmissionClaims {
  private storage: DurableSafetyStorage;
  constructor(storage: DurableSafetyStorage) { this.storage = storage; }

  claim(shopperId: string | null, orderRef: string, submittedAt: number): Promise<boolean> {
    const work = claimTail.then(async () => {
      if (!shopperId?.trim() || !orderRef.trim() || !Number.isFinite(submittedAt)) return false;
      const key = intentKey(shopperId, orderRef);
      try {
        if (await this.storage.getItem(key) !== null) return false;
        const value = JSON.stringify({ state: 'unknown', submittedAt });
        await this.storage.setItem(key, value);
        return await this.storage.getItem(key) === value;
      } catch {
        return false;
      }
    });
    claimTail = work.catch(() => undefined);
    return work;
  }
}

export class PersistedBrowserOwner {
  private owner: string | null = null;
  private generation = 0;
  private listeners = new Set<() => void>();

  private storage: DurableSafetyStorage;
  constructor(storage: DurableSafetyStorage) { this.storage = storage; }

  isReady(shopperId: string | null): boolean {
    return Boolean(activeBrowserOwner === this && shopperId && this.owner === shopperId);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  invalidate(): void {
    this.generation += 1;
    this.owner = null;
    for (const listener of this.listeners) listener();
  }

  async initialize(shopperId: string | null, reset: () => Promise<void>, forceReset = false): Promise<boolean> {
    activeBrowserOwner?.invalidate();
    activeBrowserOwner = this;
    this.invalidate();
    const generation = this.generation;
    try {
      const persisted = await this.storage.getItem(OWNER_KEY);
      if (generation !== this.generation) return false;
      if (forceReset || !shopperId || persisted !== shopperId) {
        await this.storage.setItem(OWNER_KEY, '');
        await reset();
        if (generation !== this.generation) return false;
        if (!shopperId) return false;
        await this.storage.setItem(OWNER_KEY, shopperId);
      }
      if (generation !== this.generation || await this.storage.getItem(OWNER_KEY) !== shopperId) return false;
      if (generation !== this.generation) return false;
      this.owner = shopperId;
      for (const listener of this.listeners) listener();
      return Boolean(shopperId);
    } catch {
      return false;
    }
  }
}
