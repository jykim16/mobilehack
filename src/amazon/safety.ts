import type {
  AmazonAuthChallenge,
  ApprovedBasketItem,
  CheckoutReviewLineItem,
  PlaceOrderExecutionStatus,
  ScrapedAmazonCartRow,
} from './types';

export const AMAZON_ORDER_ID_RE = /^\d{3}-\d{7}-\d{7}$/;
const ASIN_EXACT_RE = /^[A-Z0-9]{10}$/;

export function isValidPositiveCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

/**
 * Preserve active `/ap/mfa`, `/ap/cvf`, `/ax/claim`, CAPTCHA, or checkout flows when reopening
 * the browser sheet without an explicit `initialUrl`.
 */
export function shouldStartFreshSignInNavigation(params: {
  initialUrl?: string;
  isSignedIn: boolean;
  currentUrl: string;
  challenge: AmazonAuthChallenge;
}): boolean {
  if (params.initialUrl || params.isSignedIn) return false;
  if (params.challenge !== 'none') return false;
  const url = params.currentUrl || '';
  if (
    url.includes('/ap/') ||
    url.includes('/ax/') ||
    url.includes('/errors/validateCaptcha') ||
    url.includes('/gp/buy/') ||
    url.includes('/checkout/')
  ) {
    return false;
  }
  return true;
}

export function normalizeApprovedItems(input: {
  asin?: string | null;
  quantity?: number | null;
  approvedItems?: ApprovedBasketItem[] | null;
}): { ok: true; items: ApprovedBasketItem[]; totalQuantity: number } | { ok: false; reason: string } {
  const rawList: ApprovedBasketItem[] =
    input.approvedItems && input.approvedItems.length > 0
      ? input.approvedItems
      : input.asin
        ? [{ asin: input.asin, quantity: input.quantity ?? 1 }]
        : [];

  if (rawList.length === 0) {
    return {
      ok: false,
      reason: 'Fail-closed: at least one approved Amazon ASIN and quantity must be bound.',
    };
  }

  const merged = new Map<string, number>();
  for (const entry of rawList) {
    const asin = typeof entry.asin === 'string' ? entry.asin.trim().toUpperCase() : '';
    if (!ASIN_EXACT_RE.test(asin)) {
      return {
        ok: false,
        reason: `Fail-closed: invalid Amazon ASIN "${String(entry.asin)}".`,
      };
    }
    const qty = entry.quantity;
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > 10) {
      return {
        ok: false,
        reason: `Fail-closed: invalid quantity (${String(qty)}) for ASIN ${asin}; expected integer 1..10.`,
      };
    }
    merged.set(asin, (merged.get(asin) ?? 0) + qty);
  }

  const items: ApprovedBasketItem[] = [];
  let totalQuantity = 0;
  for (const [asin, quantity] of merged.entries()) {
    if (quantity > 10) {
      return {
        ok: false,
        reason: `Fail-closed: combined quantity (${quantity}) for ASIN ${asin} exceeds limit 10.`,
      };
    }
    items.push({ asin, quantity });
    totalQuantity += quantity;
  }

  return { ok: true, items, totalQuantity };
}

export type BasketBindingFailureCode =
  | 'invalid_approved_spec'
  | 'basket_empty'
  | 'unexpected_cart_items'
  | 'missing_approved_item'
  | 'quantity_mismatch'
  | 'out_of_stock';

export type BasketBindingResult =
  | { ok: true; approvedItems: ApprovedBasketItem[]; matchedRows: ScrapedAmazonCartRow[] }
  | { ok: false; code: BasketBindingFailureCode; reason: string };

/**
 * Verify that `/gp/cart/view.html` active rows contain ONLY the approved ASIN(s)
 * at the exact approved quantities before `proceedToRetailCheckout` is allowed.
 */
export function verifyActiveBasketBinding(
  activeCartRows: ScrapedAmazonCartRow[],
  spec: {
    asin?: string | null;
    quantity?: number | null;
    approvedItems?: ApprovedBasketItem[] | null;
    navCartCount?: number | null;
  },
): BasketBindingResult {
  const normalized = normalizeApprovedItems(spec);
  if (!normalized.ok) {
    return {
      ok: false,
      code: 'invalid_approved_spec',
      reason: normalized.reason,
    };
  }

  if (activeCartRows.length === 0) {
    return {
      ok: false,
      code: 'basket_empty',
      reason: 'Amazon active cart is empty.',
    };
  }

  const expectedByAsin = new Map<string, number>(
    normalized.items.map((item) => [item.asin, item.quantity]),
  );

  const observedByAsin = new Map<string, number>();
  let observedTotalQty = 0;

  for (const row of activeCartRows) {
    const asin = row.asin.trim().toUpperCase();
    if (!row.inStock) {
      return {
        ok: false,
        code: 'out_of_stock',
        reason: `Fail-closed: active cart item ${asin} is marked out of stock.`,
      };
    }
    if (!expectedByAsin.has(asin)) {
      return {
        ok: false,
        code: 'unexpected_cart_items',
        reason: `Fail-closed: Amazon active cart contains unapproved ASIN ${asin}; refusing whole-cart checkout.`,
      };
    }
    observedByAsin.set(asin, (observedByAsin.get(asin) ?? 0) + row.quantity);
    observedTotalQty += row.quantity;
  }

  for (const [asin, expectedQty] of expectedByAsin.entries()) {
    const observedQty = observedByAsin.get(asin);
    if (observedQty === undefined) {
      return {
        ok: false,
        code: 'missing_approved_item',
        reason: `Fail-closed: approved ASIN ${asin} is missing from the active Amazon cart.`,
      };
    }
    if (observedQty !== expectedQty) {
      return {
        ok: false,
        code: 'quantity_mismatch',
        reason: `Fail-closed: active Amazon cart quantity (${observedQty}) for ${asin} does not match approved quantity (${expectedQty}).`,
      };
    }
  }

  if (
    typeof spec.navCartCount === 'number' &&
    Number.isFinite(spec.navCartCount) &&
    spec.navCartCount !== observedTotalQty
  ) {
    return {
      ok: false,
      code: 'unexpected_cart_items',
      reason: `Fail-closed: Amazon header cart badge (${spec.navCartCount}) differs from active approved item count (${observedTotalQty}).`,
    };
  }

  return {
    ok: true,
    approvedItems: normalized.items,
    matchedRows: activeCartRows,
  };
}

/**
 * Verify that the SPC / Chewbacca checkout review page exposes complete, 1:1 ASIN-to-quantity
 * evidence matching `approvedItems`. Rejects missing, partial, or unidentified line items.
 */
export function verifyCheckoutReviewBinding(params: {
  approvedItems: ApprovedBasketItem[];
  summaryItemCount?: number | null;
  lineItems?: CheckoutReviewLineItem[] | null;
}): { ok: true } | { ok: false; reason: string } {
  const normalized = normalizeApprovedItems({ approvedItems: params.approvedItems });
  if (!normalized.ok) {
    return { ok: false, reason: normalized.reason };
  }

  const expectedByAsin = new Map<string, number>(
    normalized.items.map((item) => [item.asin, item.quantity]),
  );

  const hasSummaryCount =
    typeof params.summaryItemCount === 'number' && Number.isInteger(params.summaryItemCount);
  if (hasSummaryCount && params.summaryItemCount !== normalized.totalQuantity) {
    return {
      ok: false,
      reason: `Fail-closed: checkout summary item count (${params.summaryItemCount}) does not match approved quantity (${normalized.totalQuantity}).`,
    };
  }

  const lineItems = params.lineItems ?? [];
  if (lineItems.length === 0) {
    return {
      ok: false,
      reason:
        'Fail-closed: checkout review page did not expose verifiable ASIN line items.',
    };
  }

  const observedByAsin = new Map<string, number>();
  let observedTotalQty = 0;

  for (const li of lineItems) {
    const rawAsin = typeof li.asin === 'string' ? li.asin.trim().toUpperCase() : '';
    if (!ASIN_EXACT_RE.test(rawAsin)) {
      return {
        ok: false,
        reason: `Fail-closed: checkout review includes a line item ("${li.title || 'unknown'}") without a verifiable 10-character ASIN.`,
      };
    }
    if (!expectedByAsin.has(rawAsin)) {
      return {
        ok: false,
        reason: `Fail-closed: checkout review includes unapproved ASIN ${rawAsin}.`,
      };
    }
    if (typeof li.quantity !== 'number' || !Number.isInteger(li.quantity) || li.quantity < 1) {
      return {
        ok: false,
        reason: `Fail-closed: checkout review line item ${rawAsin} has invalid quantity (${String(li.quantity)}).`,
      };
    }
    observedByAsin.set(rawAsin, (observedByAsin.get(rawAsin) ?? 0) + li.quantity);
    observedTotalQty += li.quantity;
  }

  if (observedTotalQty !== normalized.totalQuantity) {
    return {
      ok: false,
      reason: `Fail-closed: checkout line-item quantity sum (${observedTotalQty}) differs from approved quantity (${normalized.totalQuantity}).`,
    };
  }

  for (const [asin, expectedQty] of expectedByAsin.entries()) {
    const observedQty = observedByAsin.get(asin);
    if (observedQty === undefined) {
      return {
        ok: false,
        reason: `Fail-closed: approved ASIN ${asin} is missing from checkout review line items.`,
      };
    }
    if (observedQty !== expectedQty) {
      return {
        ok: false,
        reason: `Fail-closed: checkout review quantity (${observedQty}) for ${asin} differs from approved quantity (${expectedQty}).`,
      };
    }
  }

  return { ok: true };
}

export type PreSubmitGateDecision =
  | {
      allowSubmit: true;
      expectedTotalCents: number;
      approvedItems: ApprovedBasketItem[];
      totalQuantity: number;
    }
  | {
      allowSubmit: false;
      status: Exclude<PlaceOrderExecutionStatus, 'placed' | 'unknown'>;
      reason: string;
    };

/**
 * Host-level fail-closed gate evaluated before `buildSubmitCheckoutOrderScript` is ever injected.
 */
export function evaluatePreSubmitSafetyGate(params: {
  dryRun: boolean;
  userConfirmed: boolean;
  approvedItems?: ApprovedBasketItem[] | null;
  asin?: string | null;
  quantity?: number | null;
  expectedTotalCents?: unknown;
  requiresSignIn: boolean;
  basketBound: boolean;
  basketBindingReason?: string;
  checkoutReviewBound: boolean;
  checkoutReviewReason?: string;
  liveTotalVerified: boolean;
  liveTotalCents?: unknown;
}): PreSubmitGateDecision {
  if (params.dryRun !== false || params.userConfirmed !== true) {
    return {
      allowSubmit: false,
      status: 'dry_run_halted',
      reason: 'Halted by dryRun safety gate before final Place Order submission.',
    };
  }

  if (!isValidPositiveCents(params.expectedTotalCents)) {
    return {
      allowSubmit: false,
      status: 'safety_blocked',
      reason:
        'Fail-closed: expectedTotalCents must be a positive integer before Place Order can execute.',
    };
  }

  const normalized = normalizeApprovedItems({
    approvedItems: params.approvedItems,
    asin: params.asin,
    quantity: params.quantity,
  });
  if (!normalized.ok) {
    return {
      allowSubmit: false,
      status: 'safety_blocked',
      reason: normalized.reason,
    };
  }

  if (!params.basketBound) {
    return {
      allowSubmit: false,
      status: 'basket_mismatch',
      reason:
        params.basketBindingReason ??
        'Fail-closed: active Amazon cart does not match the approved item(s) and quantity.',
    };
  }

  if (params.requiresSignIn) {
    return {
      allowSubmit: false,
      status: 'requires_signin',
      reason: 'Amazon sign-in required before placing a live order.',
    };
  }

  if (!params.checkoutReviewBound) {
    return {
      allowSubmit: false,
      status: 'basket_mismatch',
      reason:
        params.checkoutReviewReason ??
        'Fail-closed: checkout review items/quantities do not match the approved basket.',
    };
  }

  if (!params.liveTotalVerified || !isValidPositiveCents(params.liveTotalCents)) {
    return {
      allowSubmit: false,
      status: 'safety_blocked',
      reason:
        'Fail-closed: liveTotalCents is missing, non-finite, or <= 0 on the Amazon checkout review screen.',
    };
  }

  if (Math.abs(params.liveTotalCents - params.expectedTotalCents) > 1) {
    return {
      allowSubmit: false,
      status: 'requote_required',
      reason: `Fail-closed: live checkout total (${params.liveTotalCents} cents) differs from approved quote (${params.expectedTotalCents} cents).`,
    };
  }

  return {
    allowSubmit: true,
    expectedTotalCents: params.expectedTotalCents,
    approvedItems: normalized.items,
    totalQuantity: normalized.totalQuantity,
  };
}

export type ConfirmationResolution =
  | { status: 'placed'; retailerOrderId: string }
  | { status: 'unknown'; retailerOrderId: null; reason: string };

/**
 * Resolve post-submit confirmation strictly from a verified Amazon order ID (`###-#######-#######`)
 * on a non-auth/non-error confirmation surface. Never invents `AMZ-PENDING-*`.
 */
export function resolveOrderConfirmationOutcome(confirmation: {
  retailerOrderId?: string | null;
  isConfirmationSurface?: boolean;
  hasAuthOrErrorBarrier?: boolean;
  currentUrl?: string;
}): ConfirmationResolution {
  const id = confirmation.retailerOrderId?.trim() ?? '';
  if (
    !confirmation.hasAuthOrErrorBarrier &&
    confirmation.isConfirmationSurface !== false &&
    AMAZON_ORDER_ID_RE.test(id)
  ) {
    return {
      status: 'placed',
      retailerOrderId: id,
    };
  }

  return {
    status: 'unknown',
    retailerOrderId: null,
    reason:
      'Place Order was submitted, but no real Amazon order ID (###-#######-#######) was confirmed on the thank-you page. Returning status="unknown" (retailerOrderId=null) so syncOrders() reconciles before any retry.',
  };
}

export interface SyncedOrderCandidate {
  retailerOrderId: string;
  asin: string | null;
  asins?: string[];
  items?: ApprovedBasketItem[];
  totalCents?: number | null;
  placedAtMs?: number | null;
  syncedAt: number;
}

export type LedgerEntry =
  | { state: 'placed'; retailerOrderId: string; placedAt: number }
  | {
      state: 'unknown';
      submittedAt: number;
      approvedItems: ApprovedBasketItem[];
      expectedTotalCents: number;
      preExistingOrderIds: Set<string>;
    };

export interface ItemCheckoutBinding {
  itemId: string;
  requestId: string;
  quoteVersion: number;
  orderRef: string;
  asin: string;
  quantity: number;
}

/**
 * Stateful idempotency & reconciliation ledger keyed by `orderRef`, paired with a per-item
 * checkout identity map (`itemId -> { requestId, quoteVersion, orderRef, asin, quantity }`).
 * - Prevents double-submission when an earlier attempt is `'placed'` OR `'unknown'`, even if
 *   the caller retries `checkoutAmazonItem({ item })` without passing `orderRef` / `requestId`.
 * - Never matches historical orders known before `submittedAt`, orders missing parsed ASINs,
 *   orders with mismatched totals, orders dated prior to the submission day, or ambiguous multi-matches.
 */
export class OrderSubmissionLedger {
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly itemBindings = new Map<string, ItemCheckoutBinding>();
  private readonly observedHistoricalOrderIds = new Set<string>();

  get(orderRef: string): LedgerEntry | undefined {
    return this.entries.get(orderRef);
  }

  getItemBinding(itemId: string): ItemCheckoutBinding | undefined {
    return this.itemBindings.get(itemId);
  }

  bindItemCheckout(binding: ItemCheckoutBinding): void {
    this.itemBindings.set(binding.itemId, {
      itemId: binding.itemId,
      requestId: binding.requestId,
      quoteVersion: binding.quoteVersion,
      orderRef: binding.orderRef,
      asin: binding.asin.trim().toUpperCase(),
      quantity: binding.quantity,
    });
  }

  clearItemBinding(itemId: string): void {
    this.itemBindings.delete(itemId);
  }

  clear(): void {
    this.entries.clear();
    this.itemBindings.clear();
    this.observedHistoricalOrderIds.clear();
  }

  noteObservedOrderIds(orderIds: Iterable<string>): void {
    for (const id of orderIds) {
      if (AMAZON_ORDER_ID_RE.test(id)) {
        this.observedHistoricalOrderIds.add(id);
      }
    }
  }

  recordPlaced(orderRef: string, retailerOrderId: string, placedAt: number): void {
    if (!AMAZON_ORDER_ID_RE.test(retailerOrderId)) {
      throw new Error(`Refusing to record non-Amazon order ID "${retailerOrderId}" as placed.`);
    }
    this.observedHistoricalOrderIds.add(retailerOrderId);
    this.entries.set(orderRef, { state: 'placed', retailerOrderId, placedAt });
  }

  recordUnknown(params: {
    orderRef: string;
    submittedAt: number;
    approvedItems: ApprovedBasketItem[];
    expectedTotalCents: number;
    preExistingOrderIds?: Iterable<string>;
  }): void {
    const existing = this.entries.get(params.orderRef);
    if (existing?.state === 'placed') return;

    const preExisting = new Set<string>(this.observedHistoricalOrderIds);
    if (params.preExistingOrderIds) {
      for (const id of params.preExistingOrderIds) {
        if (AMAZON_ORDER_ID_RE.test(id)) preExisting.add(id);
      }
    }

    this.entries.set(params.orderRef, {
      state: 'unknown',
      submittedAt: params.submittedAt,
      approvedItems: params.approvedItems,
      expectedTotalCents: params.expectedTotalCents,
      preExistingOrderIds: preExisting,
    });
  }

  /**
   * Reconcile `'unknown'` entries strictly against newly observed orders with complete ASIN,
   * total, and date alignment. Ambiguous (0 or >1) candidates stay `'unknown'`.
   */
  reconcileFromSyncedOrders(
    syncedOrders: SyncedOrderCandidate[],
  ): { orderRef: string; retailerOrderId: string; placedAt: number }[] {
    const reconciled: { orderRef: string; retailerOrderId: string; placedAt: number }[] = [];
    const claimedOrderIds = new Set<string>();
    for (const entry of this.entries.values()) {
      if (entry.state === 'placed') {
        claimedOrderIds.add(entry.retailerOrderId);
      }
    }

    for (const [orderRef, entry] of this.entries.entries()) {
      if (entry.state !== 'unknown') continue;
      const expectedByAsin = new Map<string, number>();
      for (const item of entry.approvedItems) {
        const key = item.asin.trim().toUpperCase();
        expectedByAsin.set(key, (expectedByAsin.get(key) ?? 0) + item.quantity);
      }

      // Start of local calendar day containing submittedAt (Your Orders headers carry calendar dates)
      const submissionDayFloor = new Date(entry.submittedAt);
      submissionDayFloor.setHours(0, 0, 0, 0);
      const minOrderMs = submissionDayFloor.getTime();
      const maxOrderMs = entry.submittedAt + 48 * 60 * 60 * 1000;

      const candidates = syncedOrders.filter((ord) => {
        if (!AMAZON_ORDER_ID_RE.test(ord.retailerOrderId)) return false;
        if (claimedOrderIds.has(ord.retailerOrderId)) return false;
        if (entry.preExistingOrderIds.has(ord.retailerOrderId)) return false;

        // Require verified order date on or after submission day so historical orders never match
        if (
          typeof ord.placedAtMs !== 'number' ||
          !Number.isFinite(ord.placedAtMs) ||
          ord.placedAtMs < minOrderMs ||
          ord.placedAtMs > maxOrderMs
        ) {
          return false;
        }

        // Require verified ASIN + quantity alignment (never match an order with missing/unparsed ASINs)
        if (ord.items && ord.items.length > 0) {
          const observedByAsin = new Map<string, number>();
          for (const item of ord.items) {
            const key = typeof item.asin === 'string' ? item.asin.trim().toUpperCase() : '';
            if (!ASIN_EXACT_RE.test(key) || !expectedByAsin.has(key)) return false;
            if (!Number.isInteger(item.quantity) || item.quantity < 1) return false;
            observedByAsin.set(key, (observedByAsin.get(key) ?? 0) + item.quantity);
          }
          if (observedByAsin.size !== expectedByAsin.size) return false;
          for (const [asin, expectedQty] of expectedByAsin.entries()) {
            if (observedByAsin.get(asin) !== expectedQty) return false;
          }
        } else {
          const ordAsins = (
            ord.asins && ord.asins.length > 0
              ? ord.asins
              : ord.asin
                ? [ord.asin]
                : []
          )
            .map((a) => a.trim().toUpperCase())
            .filter((a) => ASIN_EXACT_RE.test(a));

          if (ordAsins.length === 0 || ordAsins.length !== expectedByAsin.size) {
            return false;
          }
          for (const a of ordAsins) {
            // Without per-item quantities on the card, only allow quantity === 1 per ASIN
            if (expectedByAsin.get(a) !== 1) return false;
          }
        }

        // Require total alignment (within 1 cent) and positive integer total on the order card
        if (
          typeof ord.totalCents !== 'number' ||
          !Number.isInteger(ord.totalCents) ||
          ord.totalCents <= 0 ||
          Math.abs(ord.totalCents - entry.expectedTotalCents) > 1
        ) {
          return false;
        }

        return true;
      });

      // Only reconcile when a single unambiguous new order matches
      if (candidates.length === 1) {
        const match = candidates[0]!;
        claimedOrderIds.add(match.retailerOrderId);
        this.observedHistoricalOrderIds.add(match.retailerOrderId);
        this.entries.set(orderRef, {
          state: 'placed',
          retailerOrderId: match.retailerOrderId,
          placedAt: match.syncedAt,
        });
        reconciled.push({
          orderRef,
          retailerOrderId: match.retailerOrderId,
          placedAt: match.syncedAt,
        });
      }
    }

    for (const ord of syncedOrders) {
      if (AMAZON_ORDER_ID_RE.test(ord.retailerOrderId)) {
        this.observedHistoricalOrderIds.add(ord.retailerOrderId);
      }
    }

    return reconciled;
  }
}
