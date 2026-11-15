import type {
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
 * Verify that the SPC / Chewbacca checkout review page matches the approved ASINs & quantities.
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
  const lineItems = params.lineItems ?? [];

  if (!hasSummaryCount && lineItems.length === 0) {
    return {
      ok: false,
      reason:
        'Fail-closed: checkout review page did not expose verifiable item count or line items.',
    };
  }

  if (hasSummaryCount && params.summaryItemCount !== normalized.totalQuantity) {
    return {
      ok: false,
      reason: `Fail-closed: checkout summary item count (${params.summaryItemCount}) does not match approved quantity (${normalized.totalQuantity}).`,
    };
  }

  if (lineItems.length > 0) {
    const lineItemAsins = lineItems.filter((li) => Boolean(li.asin));
    if (lineItemAsins.length > 0) {
      const observedByAsin = new Map<string, number>();
      for (const li of lineItemAsins) {
        const asin = li.asin!.trim().toUpperCase();
        if (!expectedByAsin.has(asin)) {
          return {
            ok: false,
            reason: `Fail-closed: checkout review includes unapproved ASIN ${asin}.`,
          };
        }
        observedByAsin.set(asin, (observedByAsin.get(asin) ?? 0) + li.quantity);
      }

      for (const [asin, expectedQty] of expectedByAsin.entries()) {
        const observedQty = observedByAsin.get(asin);
        if (observedQty !== undefined && observedQty !== expectedQty) {
          return {
            ok: false,
            reason: `Fail-closed: checkout review quantity (${observedQty}) for ${asin} differs from approved quantity (${expectedQty}).`,
          };
        }
      }
    } else {
      const summedLineQty = lineItems.reduce((sum, li) => sum + li.quantity, 0);
      if (summedLineQty !== normalized.totalQuantity) {
        return {
          ok: false,
          reason: `Fail-closed: checkout line-item quantity sum (${summedLineQty}) differs from approved quantity (${normalized.totalQuantity}).`,
        };
      }
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

export type LedgerEntry =
  | { state: 'placed'; retailerOrderId: string; placedAt: number }
  | { state: 'unknown'; submittedAt: number; approvedAsins: string[] };

/**
 * Stateful idempotency ledger keyed by `orderRef`.
 * Prevents double-submission when an earlier attempt is already `'placed'` OR `'unknown'`
 * (uncertain post-submit outcome must reconcile via `syncOrders()` before retrying).
 */
export class OrderSubmissionLedger {
  private readonly entries = new Map<string, LedgerEntry>();

  get(orderRef: string): LedgerEntry | undefined {
    return this.entries.get(orderRef);
  }

  recordPlaced(orderRef: string, retailerOrderId: string, placedAt: number): void {
    if (!AMAZON_ORDER_ID_RE.test(retailerOrderId)) {
      throw new Error(`Refusing to record non-Amazon order ID "${retailerOrderId}" as placed.`);
    }
    this.entries.set(orderRef, { state: 'placed', retailerOrderId, placedAt });
  }

  recordUnknown(orderRef: string, submittedAt: number, approvedAsins: string[]): void {
    const existing = this.entries.get(orderRef);
    if (existing?.state === 'placed') return;
    this.entries.set(orderRef, { state: 'unknown', submittedAt, approvedAsins });
  }

  /**
   * Reconcile any `'unknown'` ledger entry when `syncOrders()` observes a matching placed order.
   */
  reconcileFromSyncedOrders(
    syncedOrders: { retailerOrderId: string; asin: string | null; syncedAt: number }[],
  ): { orderRef: string; retailerOrderId: string; placedAt: number }[] {
    const reconciled: { orderRef: string; retailerOrderId: string; placedAt: number }[] = [];
    for (const [orderRef, entry] of this.entries.entries()) {
      if (entry.state !== 'unknown') continue;
      const match = syncedOrders.find(
        (ord) =>
          AMAZON_ORDER_ID_RE.test(ord.retailerOrderId) &&
          (!ord.asin || entry.approvedAsins.includes(ord.asin.toUpperCase())),
      );
      if (match) {
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
    return reconciled;
  }
}
