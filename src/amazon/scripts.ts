/**
 * Injected JavaScript builders for the persistent iOS/Android `WKWebView` engine.
 *
 * Security & privacy invariants (CREW.md):
 * 1. Never reads password fields, OTP inputs, passkeys, cookies, card numbers, or addresses.
 * 2. Never clicks Amazon's final Place Order button unless `dryRun === false && userConfirmed === true`.
 * 3. Every step script is single-page & self-contained so full-page navigations never strand promises.
 */

const SHARED_DOM_HELPERS = `
  function postToHost(payload) {
    try {
      if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
        window.ReactNativeWebView.postMessage(JSON.stringify(payload));
      }
    } catch (_) {}
  }

  function cleanText(el) {
    if (!el) return '';
    return String(el.textContent || '').replace(/\\s+/g, ' ').trim();
  }

  function parseDollarsToCents(raw) {
    if (raw === null || raw === undefined) return null;
    var cleaned = String(raw).replace(/,/g, '').trim();
    if (!cleaned) return null;
    var m = cleaned.match(/\\$\\s*(\\d+(?:\\.\\d{1,2})?)/) || cleaned.match(/(\\d+(?:\\.\\d{1,2})?)\\s*USD\\b/i);
    if (m && m[1]) {
      var val = parseFloat(m[1]);
      return isFinite(val) ? Math.round(val * 100) : null;
    }
    if (/^\\d+(?:\\.\\d{1,2})?$/.test(cleaned)) {
      var bareVal = parseFloat(cleaned);
      return isFinite(bareVal) ? Math.round(bareVal * 100) : null;
    }
    return null;
  }

  function detectAuthState() {
    var path = String(location.pathname || '');
    var href = String(location.href || '');
    var challenge = 'none';

    if (
      path.indexOf('/errors/validateCaptcha') !== -1 ||
      !!document.querySelector('form[action*="validateCaptcha"], #captchacharacters')
    ) {
      challenge = 'captcha';
    } else if (
      path.indexOf('/ap/mfa') !== -1 ||
      path.indexOf('/ap/cvf') !== -1 ||
      !!document.querySelector('#auth-mfa-otpcode, input[name="otpCode"], [id*="cvf-input"]')
    ) {
      challenge = 'mfa';
    } else if (
      path.indexOf('/ap/signin') !== -1 ||
      path.indexOf('/ax/claim') !== -1 ||
      path.indexOf('/ap/register') !== -1 ||
      !!document.querySelector('#ap_email_login, #ap_email')
    ) {
      challenge = 'signin';
    }

    if (challenge !== 'none') {
      return { signedIn: false, challenge: challenge };
    }

    // Authenticated checkout pipeline pages have no standard retail top nav
    if (
      (path.indexOf('/gp/buy/') !== -1 || path.indexOf('/checkout/') !== -1) &&
      href.indexOf('/ap/signin') === -1
    ) {
      var hasCheckoutDom = !!document.querySelector(
        '#spc-orders, #subtotals-marketplace-table, #placeYourOrder, input[name="placeYourOrder1"], [data-testid*="order-summary"]'
      );
      if (hasCheckoutDom) {
        return { signedIn: true, challenge: 'none' };
      }
    }

    // Mobile header greeting (#nav-logobar-greeting / #nav-greeting-name)
    var mobileGreeting = document.querySelector('#nav-logobar-greeting, #nav-greeting-name');
    if (mobileGreeting) {
      var mText = cleanText(mobileGreeting).toLowerCase();
      var mHref = String(mobileGreeting.getAttribute('href') || '');
      if (mText.indexOf('sign in') !== -1 || mHref.indexOf('/ap/signin') !== -1) {
        return { signedIn: false, challenge: 'none' };
      }
      if (mText.length > 0 && mText.indexOf('sign in') === -1) {
        return { signedIn: true, challenge: 'none' };
      }
    }

    // Desktop header fallback (#nav-link-accountList-nav-line-1)
    var desktopGreeting = document.querySelector('#nav-link-accountList-nav-line-1');
    if (desktopGreeting) {
      var dText = cleanText(desktopGreeting).toLowerCase();
      if (dText.indexOf('sign in') !== -1) {
        return { signedIn: false, challenge: 'none' };
      }
      if (dText.indexOf('hello,') !== -1) {
        return { signedIn: true, challenge: 'none' };
      }
    }

    var signInAnchors = document.querySelector('a[href*="/ap/signin"][id*="nav"]');
    if (signInAnchors) {
      return { signedIn: false, challenge: 'none' };
    }

    var signOutLink = document.querySelector('a[href*="/gp/flex/sign-out"], #nav-item-signout');
    if (signOutLink) {
      return { signedIn: true, challenge: 'none' };
    }

    return { signedIn: false, challenge: 'none' };
  }

  function readNavCartCount() {
    var el = document.querySelector('#nav-button-cart .nav-cart-count, #nav-cart-count, #nav-button-cart, .nav-cart-count');
    if (!el) return null;
    var m = cleanText(el).match(/(\\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
`;

export const AMAZON_PAGE_BOOTSTRAP_JS = `
(function() {
  if (window.__cartAmazonBootstrapInstalled) return true;
  window.__cartAmazonBootstrapInstalled = true;
  ${SHARED_DOM_HELPERS}

  function emitReady(reason) {
    var auth = detectAuthState();
    postToHost({
      type: 'PAGE_READY',
      reason: reason,
      url: String(location.href || ''),
      title: String(document.title || ''),
      signedIn: auth.signedIn,
      challenge: auth.challenge,
      cartCount: readNavCartCount(),
      ts: Date.now()
    });
  }

  if (document.readyState === 'interactive' || document.readyState === 'complete') {
    emitReady('immediate');
  } else {
    document.addEventListener('DOMContentLoaded', function() { emitReady('domcontentloaded'); }, { once: true });
  }
  window.addEventListener('load', function() { emitReady('load'); }, { once: true });
  window.addEventListener('popstate', function() { emitReady('popstate'); });
  return true;
})();
`;

function wrapStepScript(reqId: string, bodyJs: string): string {
  return `
(function() {
  ${SHARED_DOM_HELPERS}
  Promise.resolve().then(async function() {
    ${bodyJs}
  }).then(function(data) {
    postToHost({ type: 'STEP_RESULT', reqId: ${JSON.stringify(reqId)}, ok: true, data: data });
  }).catch(function(err) {
    postToHost({
      type: 'STEP_RESULT',
      reqId: ${JSON.stringify(reqId)},
      ok: false,
      error: err && err.message ? String(err.message) : String(err)
    });
  });
  return true;
})();
`;
}

export function buildSessionCheckScript(reqId: string): string {
  return wrapStepScript(
    reqId,
    `
    var auth = detectAuthState();
    return {
      signedIn: auth.signedIn,
      challenge: auth.challenge,
      currentUrl: String(location.href || ''),
      cartCount: readNavCartCount(),
      checkedAt: Date.now()
    };
    `,
  );
}

export function buildResolvePageAsinScript(reqId: string): string {
  return wrapStepScript(
    reqId,
    `
    var href = String(location.href || '');
    var m = href.match(/\\/(?:dp|gp\\/product|gp\\/aw\\/d|gp\\/offer-listing)\\/([A-Z0-9]{10})/i);
    if (m && m[1]) return { asin: m[1].toUpperCase(), url: href };
    var input = document.querySelector('input#ASIN, input[name="ASIN"], [data-asin]');
    var attr = input ? (input.value || input.getAttribute('data-asin')) : null;
    if (attr && /^[A-Z0-9]{10}$/i.test(attr)) {
      return { asin: attr.toUpperCase(), url: href };
    }
    return { asin: null, url: href };
    `,
  );
}

export function buildProductScrapeAndAddScript(reqId: string, quantity: number): string {
  return wrapStepScript(
    reqId,
    `
    var auth = detectAuthState();
    if (auth.challenge === 'captcha') {
      return { status: 'captcha', auth: auth };
    }

    var titleEl = document.querySelector('span#title, #title, #productTitle, [data-feature-name="title"]');
    var title = cleanText(titleEl) || String(document.title || '').replace(/^Amazon\\.com:\\s*/i, '').replace(/\\s*:\\s*[^:]+$/, '').trim();

    var payPriceEl = document.querySelector(
      '.apex-pricetopay-value .a-offscreen, .priceToPay .a-offscreen, #corePriceDisplay_mobile_feature_div .priceToPay .a-offscreen, #corePrice_feature_div .a-offscreen, .a-price .a-offscreen'
    );
    var basisPriceEl = document.querySelector('.apex-basisprice-value .a-offscreen, .basisPrice .a-offscreen');
    var unitPriceCents = parseDollarsToCents(cleanText(payPriceEl));
    var listPriceCents = parseDollarsToCents(cleanText(basisPriceEl));

    var imgEl = document.querySelector('#main-image, #landingImage, img[data-a-image-name="landingImage"], #main-image-container img');
    var imageUrl = imgEl ? (imgEl.getAttribute('data-a-hires') || imgEl.getAttribute('src')) : null;

    var deliveryEl = document.querySelector('#mir-layout-DELIVERY_BLOCK, #deliveryBlockMessage');
    var deliveryEstimate = cleanText(deliveryEl) || 'Standard Amazon delivery';

    var sellerEl = document.querySelector('#merchant-info, #shipsFromSoldByMessage_feature_div, [data-csa-c-slot-id*="odf-feature-text"]');
    var sellerRaw = cleanText(sellerEl);
    var seller = sellerRaw ? sellerRaw.slice(0, 80) : 'Amazon.com';

    var ratingEl = document.querySelector('#acrPopover, [data-hook="rating-out-of-text"], .arp-rating-out-of-text');
    var ratingText = (ratingEl && (ratingEl.getAttribute('title') || cleanText(ratingEl))) || '';
    var ratingMatch = ratingText.match(/(\\d+(?:\\.\\d+)?)\\s*out of\\s*5/i);
    var countEl = document.querySelector('#acrCustomerReviewText, [data-hook="total-review-count"]');
    var countMatch = cleanText(countEl).replace(/,/g, '').match(/(\\d+)/);
    var rating = ratingMatch
      ? { average: parseFloat(ratingMatch[1]), count: countMatch ? parseInt(countMatch[1], 10) : 0 }
      : null;

    var qty = ${Math.max(1, Math.min(10, Math.floor(quantity)))};
    var qtySelect = document.querySelector('select#mobileQuantityDropDown, select#quantity, select[name="quantity"]');
    if (qtySelect && qty > 1) {
      qtySelect.value = String(qty);
      qtySelect.dispatchEvent(new Event('change', { bubbles: true }));
    }

    var atcBtn = document.querySelector(
      '#add-to-cart-button, input[name="submit.add-to-cart"], #add-to-cart-button-ubb, #add-to-cart-button-ubb-mobile, button[name="submit.add-to-cart"]'
    );

    var productMeta = {
      title: title,
      unitPriceCents: unitPriceCents,
      listPriceCents: listPriceCents,
      imageUrl: imageUrl,
      deliveryEstimate: deliveryEstimate,
      seller: seller,
      rating: rating
    };

    if (!atcBtn) {
      var hasSeeAll = !!document.querySelector(
        '#buybox-see-all-buying-choices a, a[href*="offer-listing"], #a-autoid-0-announce'
      );
      return {
        status: 'needs_aod_fallback',
        hasSeeAll: hasSeeAll,
        productMeta: productMeta
      };
    }

    atcBtn.scrollIntoView({ block: 'center' });
    setTimeout(function() {
      try { atcBtn.click(); } catch (_) {}
    }, 60);

    return {
      status: 'clicked_primary',
      productMeta: productMeta
    };
    `,
  );
}

export function buildAodAddToCartScript(reqId: string, requestedQuantity = 1): string {
  const safeQty = Math.max(1, Math.min(10, Math.floor(requestedQuantity)));
  return wrapStepScript(
    reqId,
    `
    var qty = ${safeQty};
    var deadline = Date.now() + 4500;
    var btn = null;
    while (Date.now() < deadline) {
      btn = document.querySelector(
        '#aod-pinned-offer input[name="submit.addToCart"], #aod-offer-list input[name="submit.addToCart"], input[name="submit.addToCart"]'
      );
      if (btn) break;
      await new Promise(function(r) { setTimeout(r, 250); });
    }

    if (!btn) {
      return { clicked: false, appliedQuantity: false, seller: null, priceCents: null };
    }

    var appliedQuantity = qty === 1;
    if (qty > 1) {
      var offerScope = (btn.closest && btn.closest('form, #aod-pinned-offer, .aod-offer-block')) || document;
      var qtyField = offerScope.querySelector
        ? offerScope.querySelector('select[name="quantity"], input[name="quantity"]')
        : null;
      if (qtyField) {
        try {
          qtyField.value = String(qty);
          appliedQuantity = String(qtyField.value) === String(qty);
          if (typeof Event === 'function' && typeof qtyField.dispatchEvent === 'function') {
            qtyField.dispatchEvent(new Event('change', { bubbles: true }));
          }
        } catch (_) {
          appliedQuantity = String(qtyField.value || '') === String(qty);
        }
      }
    }

    var aria = String(btn.getAttribute('aria-label') || '');
    var sellerMatch = aria.match(/from seller\\s+(.+?)\\s+and price/i);
    var priceCents = parseDollarsToCents(aria);
    btn.scrollIntoView({ block: 'center' });
    btn.click();

    return {
      clicked: true,
      appliedQuantity: appliedQuantity,
      seller: sellerMatch && sellerMatch[1] ? sellerMatch[1].trim() : null,
      priceCents: priceCents
    };
    `,
  );
}

export function buildScrapeCartScript(reqId: string): string {
  return wrapStepScript(
    reqId,
    `
    var auth = detectAuthState();
    var activeRoot = document.querySelector('#sc-active-cart, [data-name="Active Items"], #activeCartViewForm');
    var candidateRows = Array.prototype.slice.call(
      (activeRoot || document).querySelectorAll('.sc-list-item[data-asin]')
    );
    var items = [];

    for (var i = 0; i < candidateRows.length; i++) {
      var row = candidateRows[i];
      if (row.closest && row.closest('#sc-saved-cart, [data-name="Saved Items"], #savedCartViewForm')) {
        continue;
      }
      var asin = String(row.getAttribute('data-asin') || '').trim().toUpperCase();
      if (asin.length !== 10) continue;
      if (row.getAttribute('data-removed') === 'true') continue;

      var cartItemId = row.getAttribute('data-itemid') || null;
      var rawPriceAttr = row.getAttribute('data-price');
      var fallbackPriceEl = row.querySelector('.sc-product-price, .a-price .a-offscreen');
      var unitPriceCents = parseDollarsToCents(rawPriceAttr) || parseDollarsToCents(cleanText(fallbackPriceEl)) || 0;

      var basisEl = row.querySelector('.a-text-price .a-offscreen');
      var listPriceCents = parseDollarsToCents(cleanText(basisEl));

      var rawQty = row.getAttribute('data-quantity') ||
        (row.querySelector('input[name="quantityBox"]') && row.querySelector('input[name="quantityBox"]').value) ||
        cleanText(row.querySelector('[data-a-selector="value"], .a-dropdown-prompt')) ||
        '1';
      var quantity = Math.max(1, parseInt(String(rawQty), 10) || 1);

      var titleEl = row.querySelector('.sc-product-title .a-truncate-full') ||
        row.querySelector('.sc-product-title') ||
        row.querySelector('.a-truncate-full');
      var title = cleanText(titleEl) || ('Amazon Item ' + asin);

      var prodImg = row.querySelector('img.sc-product-image');
      var anyImg = prodImg || row.querySelector('img:not([src*="loading-"])');
      var imgSrc = anyImg ? (anyImg.getAttribute('src') || null) : null;
      if (imgSrc && imgSrc.indexOf('loading-') !== -1) {
        imgSrc = null;
      }

      var inStock = row.getAttribute('data-outofstock') !== '1';

      items.push({
        asin: asin,
        cartItemId: cartItemId,
        title: title,
        unitPriceCents: unitPriceCents,
        listPriceCents: listPriceCents,
        quantity: quantity,
        imageUrl: imgSrc,
        seller: 'Amazon.com',
        deliveryEstimate: 'Eligible for Amazon delivery',
        returnSummary: '30-day Amazon return policy',
        inStock: inStock
      });
    }

    var subtotalEl = document.querySelector(
      '#sc-subtotal-amount-activecart .sc-price, #sc-subtotal-amount-buybox .sc-price, .sc-price-sign'
    );
    var computedSubtotal = items.reduce(function(acc, item) {
      return acc + item.unitPriceCents * item.quantity;
    }, 0);
    var subtotalCents = parseDollarsToCents(cleanText(subtotalEl)) || computedSubtotal;
    var navCount = readNavCartCount();
    var itemQtySum = items.reduce(function(acc, item) { return acc + item.quantity; }, 0);

    return {
      signedIn: auth.signedIn,
      challenge: auth.challenge,
      currentUrl: String(location.href || ''),
      cartCount: navCount != null ? navCount : itemQtySum,
      subtotalCents: subtotalCents,
      items: items
    };
    `,
  );
}

export function buildMutateCartRowScript(
  reqId: string,
  asin: string,
  operation: 'increment' | 'decrement' | 'delete',
): string {
  return wrapStepScript(
    reqId,
    `
    var targetAsin = ${JSON.stringify(asin.toUpperCase())};
    var op = ${JSON.stringify(operation)};
    var row = document.querySelector('.sc-list-item[data-asin="' + targetAsin + '"]');
    if (!row) {
      return { mutated: false, reason: 'item_not_in_cart' };
    }

    var control = null;
    if (op === 'delete') {
      control = row.querySelector(
        'input[data-action="delete-active"], input[name^="submit.delete-active."], [data-action="delete"] input, input[value^="Delete"]'
      );
      var rowQty = parseInt(String(row.getAttribute('data-quantity') || '1'), 10) || 1;
      if (!control && rowQty === 1) {
        control = row.querySelector('button[data-action="a-stepper-decrement"]');
      }
    } else if (op === 'increment') {
      control = row.querySelector('button[data-action="a-stepper-increment"]');
    } else if (op === 'decrement') {
      control = row.querySelector('button[data-action="a-stepper-decrement"]');
    }

    if (!control) {
      return { mutated: false, reason: 'control_not_found' };
    }

    control.scrollIntoView({ block: 'center' });
    control.click();
    return { mutated: true };
    `,
  );
}

export function buildClickProceedToCheckoutScript(reqId: string): string {
  return wrapStepScript(
    reqId,
    `
    var ptcBtn = document.querySelector(
      'input[name="proceedToRetailCheckout"], button[name="proceedToRetailCheckout"], #sc-buy-box-ptc-button input, [data-feature-id="proceed-to-checkout-action"] input, [data-feature-id="proceed-to-checkout-action"] button'
    );
    if (!ptcBtn) {
      return { clicked: false, currentUrl: String(location.href || '') };
    }
    ptcBtn.scrollIntoView({ block: 'center' });
    setTimeout(function() {
      try { ptcBtn.click(); } catch (_) {}
    }, 60);
    return { clicked: true, currentUrl: String(location.href || '') };
    `,
  );
}

const CHECKOUT_SUMMARY_AND_BASKET_HELPERS = `
  function inspectCheckoutSummaryAndItems() {
    var summaryRows = Array.prototype.slice.call(
      document.querySelectorAll('#subtotals-marketplace-table tr, #spc-order-summary tr, [data-testid*="order-summary"] div, [data-testid*="order-summary"] tr')
    );

    var subtotalCents = null;
    var shippingCents = null;
    var taxCents = null;
    var totalCents = null;
    var summaryItemCount = null;

    for (var i = 0; i < summaryRows.length; i++) {
      var line = cleanText(summaryRows[i]);
      if (!line) continue;
      var itemCountMatch = line.match(/items?\\s*\\((\\d+)\\)/i);
      if (itemCountMatch && itemCountMatch[1] && summaryItemCount === null) {
        summaryItemCount = parseInt(itemCountMatch[1], 10);
      }
      if (/items?\\s*(\\(|:)/i.test(line) && subtotalCents === null) {
        subtotalCents = parseDollarsToCents(line);
      } else if (/shipping\\s*&\\s*handling|delivery/i.test(line) && shippingCents === null) {
        shippingCents = /free/i.test(line) ? 0 : parseDollarsToCents(line);
      } else if (/estimated\\s+tax|tax\\s+to\\s+be\\s+collected/i.test(line) && taxCents === null) {
        taxCents = parseDollarsToCents(line);
      } else if (/order\\s+total|grand\\s+total/i.test(line)) {
        var parsedTotal = parseDollarsToCents(line);
        if (parsedTotal !== null) totalCents = parsedTotal;
      }
    }

    var grandTotalEl = document.querySelector(
      '.grand-total-price, #subtotals-marketplace-table .grand-total-price, [data-testid="order-total-amount"]'
    );
    if (grandTotalEl) {
      var explicitTotal = parseDollarsToCents(cleanText(grandTotalEl));
      if (explicitTotal !== null) totalCents = explicitTotal;
    }

    var itemContainer = document.querySelector('#spc-orders, #checkout-item-block, [data-testid*="shipment"], main') || document;
    var itemNodes = Array.prototype.slice.call(
      itemContainer.querySelectorAll('[data-asin], [data-testid*="line-item"], .checkout-item, .shipment-item')
    );

    var lineItems = [];
    var seenNodes = [];
    for (var j = 0; j < itemNodes.length; j++) {
      var el = itemNodes[j];
      var nestedDup = false;
      for (var k = 0; k < seenNodes.length; k++) {
        if (seenNodes[k].contains && seenNodes[k].contains(el)) {
          nestedDup = true;
          break;
        }
      }
      if (nestedDup) continue;

      var rawAsin = String(el.getAttribute('data-asin') || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(rawAsin) && el.querySelector) {
        var link = el.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
        var hm = link ? String(link.getAttribute('href') || '').match(/\\/(?:dp|gp\\/product)\\/([A-Z0-9]{10})/i) : null;
        if (hm && hm[1]) {
          rawAsin = hm[1].toUpperCase();
        } else {
          var hiddenAsin = el.querySelector('input[name*="asin" i]');
          var hv = hiddenAsin ? String(hiddenAsin.value || hiddenAsin.getAttribute('value') || '').trim().toUpperCase() : '';
          if (/^[A-Z0-9]{10}$/.test(hv)) rawAsin = hv;
        }
      }

      var titleNode = el.querySelector
        ? el.querySelector('.asin-title, [data-testid*="item-title"], .a-text-bold')
        : null;
      var itemTitle = cleanText(titleNode) || cleanText(el).slice(0, 120);
      if (!rawAsin && !itemTitle) continue;

      var qtyNode = el.querySelector
        ? el.querySelector('.quantity-display, [data-testid*="item-quantity"], select[name*="quantity"]')
        : null;
      var qtyVal = 1;
      if (qtyNode) {
        var qRaw = qtyNode.value || cleanText(qtyNode);
        var qm = String(qRaw || '').match(/(\\d+)/);
        if (qm && qm[1]) qtyVal = Math.max(1, parseInt(qm[1], 10));
      } else {
        var inlineQty = cleanText(el).match(/(?:Qty|Quantity)\\s*:?\\s*(\\d+)/i);
        if (inlineQty && inlineQty[1]) qtyVal = Math.max(1, parseInt(inlineQty[1], 10));
      }

      seenNodes.push(el);
      lineItems.push({
        asin: /^[A-Z0-9]{10}$/.test(rawAsin) ? rawAsin : null,
        title: itemTitle,
        quantity: qtyVal
      });
    }

    if (summaryItemCount === null && lineItems.length === 1 && subtotalCents !== null) {
      summaryItemCount = lineItems[0].quantity;
    }

    return {
      subtotalCents: subtotalCents,
      shippingCents: shippingCents != null ? shippingCents : 0,
      taxCents: taxCents != null ? taxCents : 0,
      totalCents: totalCents,
      summaryItemCount: summaryItemCount,
      lineItems: lineItems
    };
  }
`;

/**
 * Strictly read-only inspection of the checkout screen (or sign-in gate).
 * Never interacts with `placeYourOrder` or `submitOrderButtonId`.
 */
export function buildInspectCheckoutReviewScript(reqId: string): string {
  return wrapStepScript(
    reqId,
    `
    ${CHECKOUT_SUMMARY_AND_BASKET_HELPERS}
    var auth = detectAuthState();
    var href = String(location.href || '');

    if (auth.challenge === 'captcha') {
      return {
        stage: 'captcha_gate',
        signedIn: false,
        canPlaceOrder: false,
        currentUrl: href
      };
    }

    if (!auth.signedIn || auth.challenge === 'signin' || auth.challenge === 'mfa') {
      return {
        stage: 'signin_gate',
        signedIn: false,
        challenge: auth.challenge,
        canPlaceOrder: false,
        currentUrl: href
      };
    }

    var parsed = inspectCheckoutSummaryAndItems();

    var deliveryEl = document.querySelector(
      '.promise-time-slot, #spc-orders .delivery-box .a-text-bold, [data-testid*="delivery-date"], #revieworder .a-color-success, .shipping-speed.selected'
    );
    var deliveryEstimate = cleanText(deliveryEl) || 'Amazon checkout delivery';

    var placeOrderControl = document.querySelector(
      '#placeYourOrder input, input[name="placeYourOrder1"], #submitOrderButtonId input, button[name="placeYourOrder1"]'
    );

    return {
      stage: 'checkout_review',
      signedIn: true,
      canPlaceOrder: !!placeOrderControl && typeof parsed.totalCents === 'number' && parsed.totalCents > 0,
      subtotalCents: parsed.subtotalCents,
      shippingCents: parsed.shippingCents,
      taxCents: parsed.taxCents,
      totalCents: parsed.totalCents,
      summaryItemCount: parsed.summaryItemCount,
      lineItems: parsed.lineItems,
      deliveryEstimate: deliveryEstimate,
      currentUrl: href
    };
    `,
  );
}

/**
 * Final order submission script — enforces fail-closed WebKit-side verification of:
 * 1. `dryRun === false && userConfirmed === true`
 * 2. Finite positive integer `expectedTotalCents` AND live checkout `totalCents` within 1 cent
 * 3. Approved ASIN(s) and exact item quantity binding on the live checkout review screen
 */
export function buildSubmitCheckoutOrderScript(
  reqId: string,
  guard: {
    dryRun: boolean;
    userConfirmed: boolean;
    expectedTotalCents: number;
    approvedItems: { asin: string; quantity: number }[];
  },
): string {
  return wrapStepScript(
    reqId,
    `
    ${CHECKOUT_SUMMARY_AND_BASKET_HELPERS}
    var guard = ${JSON.stringify(guard)};
    if (!guard || guard.dryRun !== false || guard.userConfirmed !== true) {
      return {
        submitted: false,
        haltedBySafetyGate: true,
        code: 'dry_run_halted',
        reason: 'In-DOM safety gate refused Place Order because dryRun !== false or userConfirmed !== true.'
      };
    }

    var expectedTotal = guard.expectedTotalCents;
    if (
      typeof expectedTotal !== 'number' ||
      !isFinite(expectedTotal) ||
      Math.floor(expectedTotal) !== expectedTotal ||
      expectedTotal <= 0
    ) {
      return {
        submitted: false,
        haltedBySafetyGate: true,
        code: 'safety_blocked',
        reason: 'In-DOM safety gate refused Place Order because expectedTotalCents is missing, non-integer, or <= 0.'
      };
    }

    if (!Array.isArray(guard.approvedItems) || guard.approvedItems.length === 0) {
      return {
        submitted: false,
        haltedBySafetyGate: true,
        code: 'safety_blocked',
        reason: 'In-DOM safety gate refused Place Order because approvedItems binding is missing.'
      };
    }

    var expectedByAsin = {};
    var expectedTotalQty = 0;
    for (var a = 0; a < guard.approvedItems.length; a++) {
      var item = guard.approvedItems[a];
      var asinKey = item && typeof item.asin === 'string' ? item.asin.trim().toUpperCase() : '';
      var q = item ? item.quantity : 0;
      if (!/^[A-Z0-9]{10}$/.test(asinKey) || typeof q !== 'number' || !isFinite(q) || Math.floor(q) !== q || q < 1 || q > 10) {
        return {
          submitted: false,
          haltedBySafetyGate: true,
          code: 'safety_blocked',
          reason: 'In-DOM safety gate refused Place Order due to invalid approvedItems specification.'
        };
      }
      expectedByAsin[asinKey] = (expectedByAsin[asinKey] || 0) + q;
      expectedTotalQty += q;
    }

    var parsed = inspectCheckoutSummaryAndItems();
    var liveTotalCents = parsed.totalCents;

    if (
      typeof liveTotalCents !== 'number' ||
      !isFinite(liveTotalCents) ||
      Math.floor(liveTotalCents) !== liveTotalCents ||
      liveTotalCents <= 0
    ) {
      return {
        submitted: false,
        haltedBySafetyGate: true,
        code: 'safety_blocked',
        liveTotalCents: liveTotalCents,
        reason: 'In-DOM safety gate refused Place Order because live checkout grand total is missing or <= 0.'
      };
    }

    if (Math.abs(liveTotalCents - expectedTotal) > 1) {
      return {
        submitted: false,
        haltedBySafetyGate: true,
        code: 'requote_required',
        liveTotalCents: liveTotalCents,
        reason: 'In-DOM safety gate refused Place Order because live checkout total (' + liveTotalCents + ') differs from approved quote (' + expectedTotal + ').'
      };
    }

    var hasSummaryCount = typeof parsed.summaryItemCount === 'number' && isFinite(parsed.summaryItemCount);
    var lineItems = parsed.lineItems || [];
    if (lineItems.length === 0) {
      return {
        submitted: false,
        haltedBySafetyGate: true,
        code: 'basket_mismatch',
        reason: 'In-DOM safety gate refused Place Order because checkout review exposed no verifiable ASIN line items.'
      };
    }

    if (hasSummaryCount && parsed.summaryItemCount !== expectedTotalQty) {
      return {
        submitted: false,
        haltedBySafetyGate: true,
        code: 'basket_mismatch',
        reason: 'In-DOM safety gate refused Place Order because checkout summary item count (' + parsed.summaryItemCount + ') != approved quantity (' + expectedTotalQty + ').'
      };
    }

    var observedByAsin = {};
    var observedTotalQty = 0;
    for (var m = 0; m < lineItems.length; m++) {
      var li = lineItems[m];
      var liAsin = li && typeof li.asin === 'string' ? li.asin.trim().toUpperCase() : '';
      if (!/^[A-Z0-9]{10}$/.test(liAsin)) {
        return {
          submitted: false,
          haltedBySafetyGate: true,
          code: 'basket_mismatch',
          reason: 'In-DOM safety gate refused Place Order because checkout contains a line item without a verifiable 10-character ASIN.'
        };
      }
      if (!expectedByAsin[liAsin]) {
        return {
          submitted: false,
          haltedBySafetyGate: true,
          code: 'basket_mismatch',
          reason: 'In-DOM safety gate refused Place Order because checkout contains unapproved ASIN ' + liAsin + '.'
        };
      }
      var liQty = li && typeof li.quantity === 'number' ? li.quantity : 0;
      if (!isFinite(liQty) || Math.floor(liQty) !== liQty || liQty < 1) {
        return {
          submitted: false,
          haltedBySafetyGate: true,
          code: 'basket_mismatch',
          reason: 'In-DOM safety gate refused Place Order because checkout line item ' + liAsin + ' has an invalid quantity.'
        };
      }
      observedByAsin[liAsin] = (observedByAsin[liAsin] || 0) + liQty;
      observedTotalQty += liQty;
    }

    if (observedTotalQty !== expectedTotalQty) {
      return {
        submitted: false,
        haltedBySafetyGate: true,
        code: 'basket_mismatch',
        reason: 'In-DOM safety gate refused Place Order because checkout line-item quantity sum (' + observedTotalQty + ') != approved quantity (' + expectedTotalQty + ').'
      };
    }

    var expectedKeys = Object.keys(expectedByAsin);
    for (var ek = 0; ek < expectedKeys.length; ek++) {
      var kAsin = expectedKeys[ek];
      if (observedByAsin[kAsin] === undefined) {
        return {
          submitted: false,
          haltedBySafetyGate: true,
          code: 'basket_mismatch',
          reason: 'In-DOM safety gate refused Place Order because approved ASIN ' + kAsin + ' is missing from checkout review line items.'
        };
      }
      if (observedByAsin[kAsin] !== expectedByAsin[kAsin]) {
        return {
          submitted: false,
          haltedBySafetyGate: true,
          code: 'basket_mismatch',
          reason: 'In-DOM safety gate refused Place Order because checkout quantity for ' + kAsin + ' (' + observedByAsin[kAsin] + ') != approved quantity (' + expectedByAsin[kAsin] + ').'
        };
      }
    }

    var placeOrderBtn = document.querySelector(
      '#placeYourOrder input, input[name="placeYourOrder1"], #submitOrderButtonId input, button[name="placeYourOrder1"]'
    );
    if (!placeOrderBtn) {
      return {
        submitted: false,
        haltedBySafetyGate: false,
        code: 'missing_button',
        reason: 'Place Order button not found on current checkout screen.'
      };
    }

    placeOrderBtn.scrollIntoView({ block: 'center' });
    setTimeout(function() {
      try { placeOrderBtn.click(); } catch (_) {}
    }, 60);

    return {
      submitted: true,
      haltedBySafetyGate: false,
      liveTotalCents: liveTotalCents
    };
    `,
  );
}

export function buildScrapeOrderConfirmationScript(reqId: string): string {
  return wrapStepScript(
    reqId,
    `
    var auth = detectAuthState();
    var path = String(location.pathname || '');
    var href = String(location.href || '');
    var bodyText = cleanText(document.body);

    var stillOnCheckoutReview = !!document.querySelector(
      '#placeYourOrder input, input[name="placeYourOrder1"], #submitOrderButtonId input, button[name="placeYourOrder1"]'
    );
    var hasPaymentOrOrderError = !!document.querySelector(
      '#imb-alert-box, [data-testid*="payment-error"], .a-alert-error'
    );
    var hasAuthOrErrorBarrier = !auth.signedIn || auth.challenge !== 'none' || stillOnCheckoutReview || hasPaymentOrOrderError;

    var isThankYouUrl =
      path.indexOf('/thankyou') !== -1 ||
      path.indexOf('/gp/buy/thankyou') !== -1 ||
      path.indexOf('/checkout/confirm') !== -1;
    var hasThankYouHeading =
      !!document.querySelector('#widget-purchaseSummary, [data-testid*="order-confirmation"]') ||
      /order placed,\\s*thanks|thank you,\\s*your order has been placed/i.test(bodyText);
    var isConfirmationSurface = (isThankYouUrl || hasThankYouHeading) && !hasAuthOrErrorBarrier;

    var orderIdMatch = isConfirmationSurface ? bodyText.match(/\\b(\\d{3}-\\d{7}-\\d{7})\\b/) : null;
    return {
      retailerOrderId: orderIdMatch ? orderIdMatch[1] : null,
      isConfirmationSurface: isConfirmationSurface,
      hasAuthOrErrorBarrier: hasAuthOrErrorBarrier,
      currentUrl: href
    };
    `,
  );
}

export function buildScrapeYourOrdersScript(reqId: string): string {
  return wrapStepScript(
    reqId,
    `
    var auth = detectAuthState();
    if (!auth.signedIn || auth.challenge !== 'none') {
      return {
        signedIn: false,
        challenge: auth.challenge,
        currentUrl: String(location.href || ''),
        orders: []
      };
    }

    var cards = Array.prototype.slice.call(
      document.querySelectorAll(
        '.order-card, .js-order-card, [data-testid="order-card"], .a-box-group.order, .item-box, li.order-item'
      )
    );

    var seenIds = {};
    var orders = [];

    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var cardText = cleanText(card);
      var idMatch = cardText.match(/\\b(\\d{3}-\\d{7}-\\d{7})\\b/);
      var detailsAnchor = card.querySelector('a[href*="orderID="], a[href*="oid="], a[href*="/progress-tracker/"]');
      var hrefOrderId = null;
      if (detailsAnchor) {
        var hm = String(detailsAnchor.getAttribute('href') || '').match(/(?:orderID|oid)=(\\d{3}-\\d{7}-\\d{7})/i);
        if (hm && hm[1]) hrefOrderId = hm[1];
      }

      var orderId = (idMatch && idMatch[1]) || hrefOrderId || ('AMZ-CARD-' + i);
      if (seenIds[orderId]) continue;
      seenIds[orderId] = true;

      var statusEl = card.querySelector(
        '.delivery-box__primary-text, .yohtmlc-shipment-status-primaryText, [data-testid="delivery-status"], .a-size-medium.a-color-base.a-text-bold, .shipment-top-row h3'
      );
      var statusHeadline = cleanText(statusEl);
      if (!statusHeadline) {
        var headlineMatch = cardText.match(/((?:Delivered|Out for delivery|Arriving|Shipped|Ordered)[^.]{0,45})/i);
        statusHeadline = headlineMatch ? headlineMatch[1].trim() : 'Ordered';
      }

      var titleEl = card.querySelector(
        '.yohtmlc-product-title, .yohtmlc-item a, a[href*="/dp/"], a[href*="/gp/product/"]'
      );
      var productTitle = cleanText(titleEl);
      if (!productTitle) continue;

      var dpAnchors = Array.prototype.slice.call(
        card.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]')
      );
      var asins = [];
      var seenAsins = {};
      for (var d = 0; d < dpAnchors.length; d++) {
        var dm = String(dpAnchors[d].getAttribute('href') || '').match(/\\/(?:dp|gp\\/product)\\/([A-Z0-9]{10})/i);
        if (dm && dm[1]) {
          var upperAsin = dm[1].toUpperCase();
          if (!seenAsins[upperAsin]) {
            seenAsins[upperAsin] = true;
            asins.push(upperAsin);
          }
        }
      }
      var asin = asins.length > 0 ? asins[0] : null;

      var qtyBadges = Array.prototype.slice.call(
        card.querySelectorAll('.item-view-qty, [data-testid="item-quantity"]')
      );
      var items = [];
      for (var qi = 0; qi < asins.length; qi++) {
        var badgeQty = qtyBadges[qi] ? parseInt(cleanText(qtyBadges[qi]), 10) : NaN;
        items.push({
          asin: asins[qi],
          quantity: isFinite(badgeQty) && badgeQty >= 1 ? badgeQty : 1
        });
      }

      var dateMatch = cardText.match(
        /(?:Order placed|Ordered on)?\\s*((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s+\\d{1,2},\\s+\\d{4})/i
      );
      var parsedDateMs = dateMatch && dateMatch[1] ? Date.parse(dateMatch[1]) : NaN;
      var placedAtMs = isFinite(parsedDateMs) ? parsedDateMs : null;

      var imgEl = card.querySelector('img');
      var imageUrl = imgEl ? imgEl.getAttribute('src') : null;

      var totalMatch = cardText.match(/(?:Total|Order Total)\\s*:?\\s*\\$?([\\d,]+\\.\\d{2})/i);
      var totalCents = totalMatch ? parseDollarsToCents(totalMatch[1]) : null;

      var trackerAnchor = card.querySelector('a[href*="/progress-tracker/package/"]');
      var trackerHref = trackerAnchor ? trackerAnchor.getAttribute('href') : null;
      var trackingUrl = trackerHref
        ? new URL(trackerHref, 'https://www.amazon.com').toString()
        : null;

      orders.push({
        retailerOrderId: orderId,
        asin: asin,
        asins: asins,
        items: items,
        placedAtMs: placedAtMs,
        productTitle: productTitle,
        imageUrl: imageUrl,
        totalCents: totalCents,
        statusHeadline: statusHeadline,
        trackingUrl: trackingUrl
      });
    }

    return {
      signedIn: true,
      challenge: 'none',
      currentUrl: String(location.href || ''),
      orders: orders
    };
    `,
  );
}

export function buildScrapeProgressTrackerScript(reqId: string): string {
  return wrapStepScript(
    reqId,
    `
    var primaryEl = document.querySelector('#primaryStatus, .pt-promise-main-slot, #milestone-message');
    var primaryStatus = cleanText(primaryEl);
    var trackingEl = document.querySelector('.pt-delivery-card-trackingId, [data-testid="tracking-id"]');
    var trackingLine = cleanText(trackingEl);
    var carrier = null;
    var trackingNumber = null;
    if (trackingLine) {
      var m = trackingLine.match(/Shipped with\\s+([^,]+?)(?:\\s*Tracking ID:?\\s*([A-Z0-9_-]+))?$/i);
      if (m) {
        carrier = m[1] ? m[1].trim() : null;
        trackingNumber = m[2] ? m[2].trim() : null;
      } else {
        var idOnly = trackingLine.match(/Tracking ID:?\\s*([A-Z0-9_-]+)/i);
        if (idOnly) trackingNumber = idOnly[1];
      }
    }

    // If a "See all updates" expander exists in DOM, expand it first so hidden scan rows hydrate
    var seeAllTrigger = document.querySelector(
      'a[data-action*="tracking-events"], [data-testid="see-all-updates"], a[href*="#tracking-events"]'
    );
    if (seeAllTrigger) {
      try { seeAllTrigger.click(); } catch (_) {}
      await new Promise(function(r) { setTimeout(r, 350); });
    }

    var rawEvents = [];
    var container = document.querySelector(
      '#tracking-events-modal, #carrierRelatedInfo-tracking-events-modal, #tracking-events-container, [data-testid="tracking-events-list"]'
    ) || document;

    var nodes = Array.prototype.slice.call(
      container.querySelectorAll(
        '.tracking-event-date-header, [data-testid="tracking-event-date-header"], .tracking-event-row, [data-testid="tracking-event-row"], .pt-tracking-event'
      )
    );

    var currentDateHeader = null;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var cls = String(node.className || '') + ' ' + String(node.getAttribute('data-testid') || '');
      if (cls.indexOf('date-header') !== -1) {
        currentDateHeader = cleanText(node) || currentDateHeader;
        continue;
      }

      var timeEl = node.querySelector('.tracking-event-time, [class*="event-time"], [data-testid*="event-time"]');
      var msgEl = node.querySelector('.tracking-event-message, [class*="event-message"], [data-testid*="event-message"]');
      var locEl = node.querySelector('.tracking-event-location, [class*="event-location"], [data-testid*="event-location"]');

      var desc = cleanText(msgEl) || cleanText(node);
      if (!desc) continue;

      rawEvents.push({
        dateText: currentDateHeader,
        timeText: cleanText(timeEl) || null,
        description: desc,
        location: cleanText(locEl) || null
      });
    }

    // Fallback to completed milestone steps on the progress tracker bar if detailed carrier scans aren't listed yet
    if (rawEvents.length === 0) {
      var milestones = Array.prototype.slice.call(
        document.querySelectorAll(
          '.pt-milestone.milestone-complete, .milestone-bar .milestone-complete, [id^="milestone-"].complete, [data-testid*="milestone-complete"]'
        )
      );
      // Reverse completed milestones so index 0 matches Amazon's newest-first convention before buildShipmentEvents reverses
      for (var j = milestones.length - 1; j >= 0; j--) {
        var mText = cleanText(milestones[j]);
        if (mText) {
          rawEvents.push({
            dateText: null,
            timeText: null,
            description: mText,
            location: null
          });
        }
      }
    }

    return {
      primaryStatus: primaryStatus || null,
      carrier: carrier,
      trackingNumber: trackingNumber,
      events: rawEvents
    };
    `,
  );
}
