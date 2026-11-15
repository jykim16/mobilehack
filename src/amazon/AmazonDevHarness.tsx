import { Image } from 'expo-image';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { type Palette, Radius, Spacing, Type, useColors, useThemedStyles } from '@/constants/theme';

import { useAmazonCartAdapter, useAmazonSession } from './AmazonBrowserProvider';
import { extractAsin, formatCents, formatRelativeSyncTime } from './asin';
import type { AmazonAddToCartResult, AmazonCheckoutQuoteResult } from './types';

const DEMO_PRODUCTS = [
  {
    asin: 'B0CCZ26B5V',
    name: 'Bose QuietComfort Wireless Headphones',
    subtitle: 'Black · Primary Buy Box ASIN',
  },
  {
    asin: 'B09XS7JWHH',
    name: 'Sony WH-1000XM5 Wireless Headphones',
    subtitle: 'Black · Hero ASIN (AOD Offer Fallback)',
  },
] as const;

export interface AmazonDevHarnessProps {
  defaultExpanded?: boolean;
}

export function AmazonDevHarness({ defaultExpanded = false }: AmazonDevHarnessProps) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useThemedStyles(createHarnessStyles);
  const session = useAmazonSession();
  const adapter = useAmazonCartAdapter();

  const [expanded, setExpanded] = useState(defaultExpanded);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [lastAddResult, setLastAddResult] = useState<AmazonAddToCartResult | null>(null);
  const [lastQuoteResult, setLastQuoteResult] = useState<AmazonCheckoutQuoteResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleAddProduct = useCallback(
    async (asin: string) => {
      setErrorMessage(null);
      setActiveAction(`add-${asin}`);
      try {
        const res = await session.addToCart({ asin, quantity: 1 });
        setLastAddResult(res);
        if (!res.ok && res.error) {
          setErrorMessage(res.error);
        }
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : String(err));
      } finally {
        setActiveAction(null);
      }
    },
    [session],
  );

  const handleDryRunQuote = useCallback(async () => {
    setErrorMessage(null);
    setActiveAction('quote');
    try {
      const singleAsin =
        adapter.items.length === 1 ? extractAsin(adapter.items[0]?.url) ?? undefined : undefined;
      const singleQty = adapter.items.length === 1 ? adapter.items[0]?.quantity : undefined;
      const res = await session.getCheckoutQuote({
        asin: singleAsin,
        quantity: singleQty,
        dryRun: true,
      });
      setLastQuoteResult(res);
      if (!res.ok && res.error) {
        setErrorMessage(res.error);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveAction(null);
    }
  }, [adapter.items, session]);

  const handleSyncOrders = useCallback(async () => {
    setErrorMessage(null);
    setActiveAction('orders');
    try {
      const res = await session.syncOrders();
      if (!res.ok && res.error) {
        setErrorMessage(res.error);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setActiveAction(null);
    }
  }, [session]);

  if (!expanded) {
    return (
      <View
        pointerEvents="box-none"
        style={[styles.fabWrapper, { bottom: Math.max(insets.bottom + 64, 88) }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open Amazon Engine Harness"
          onPress={() => setExpanded(true)}
          style={({ pressed }) => [styles.fabButton, pressed && styles.pressed]}>
          <Text style={styles.fabLabel}>Amazon Engine</Text>
        </Pressable>
      </View>
    );
  }

  const statusText =
    session.status === 'busy'
      ? 'Syncing with Amazon…'
      : session.status === 'connected'
        ? 'Connected'
        : 'Signed out';

  return (
    <View style={[styles.fullScreen, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <View style={styles.topBarLeft}>
          <Text style={styles.title}>Cart · Amazon</Text>
          <Text style={styles.metaLine}>
            {statusText} · {formatRelativeSyncTime(session.lastSyncedAt)}
          </Text>
        </View>

        <View style={styles.topBarActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Sign in to Amazon"
            onPress={() => session.openBrowserSheet()}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}>
            <Text style={styles.secondaryButtonLabel}>
              {session.status === 'connected' ? 'Browser' : 'Sign in'}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Minimize harness"
            hitSlop={10}
            onPress={() => setExpanded(false)}
            style={({ pressed }) => [styles.plainClose, pressed && styles.pressed]}>
            <Text style={styles.plainCloseLabel}>Done</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: Math.max(insets.bottom + 28, 40) },
        ]}>
        <View style={styles.section}>
          <Text style={styles.sectionHeading}>Live Amazon Catalog</Text>
          {DEMO_PRODUCTS.map((product) => {
            const isAdding = activeAction === `add-${product.asin}`;
            return (
              <View key={product.asin} style={styles.card}>
                <View style={styles.cardRow}>
                  <View style={styles.cardInfo}>
                    <Text style={styles.cardTitle}>{product.name}</Text>
                    <Text style={styles.cardMuted}>
                      {product.subtitle} · {product.asin}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Add ${product.asin} to Amazon Cart`}
                    disabled={session.status === 'busy'}
                    onPress={() => void handleAddProduct(product.asin)}
                    style={({ pressed }) => [
                      styles.primaryAction,
                      session.status === 'busy' && styles.disabledAction,
                      pressed && styles.pressed,
                    ]}>
                    {isAdding ? (
                      <ActivityIndicator size="small" color={colors.onStrong} />
                    ) : (
                      <Text style={styles.primaryActionLabel}>Add</Text>
                    )}
                  </Pressable>
                </View>
              </View>
            );
          })}
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionHeading}>
              Synced Amazon Cart ({adapter.items.reduce((sum, i) => sum + i.quantity, 0)})
            </Text>
            {lastAddResult && (
              <Text style={styles.sectionCaption}>
                Subtotal {formatCents(lastAddResult.subtotalCents)}
              </Text>
            )}
          </View>

          {adapter.items.length === 0 ? (
            <View style={styles.emptyCard}>
              <Text style={styles.cardMuted}>
                Tap Add above to drive the persistent WKWebView on amazon.com and sync live cart
                items back into React Native.
              </Text>
            </View>
          ) : (
            adapter.items.map((item) => (
              <View key={item.id} style={styles.card}>
                <View style={styles.cartItemRow}>
                  {item.product?.imageUrl ? (
                    <Image
                      source={{ uri: item.product.imageUrl }}
                      style={styles.productThumb}
                      contentFit="contain"
                    />
                  ) : (
                    <View style={styles.productThumbPlaceholder} />
                  )}
                  <View style={styles.cardInfo}>
                    <Text style={styles.cardTitle} numberOfLines={2}>
                      {item.product?.title}
                    </Text>
                    <Text style={styles.cardMuted} numberOfLines={1}>
                      {item.offer?.retailerName} · {item.offer?.seller} · Qty {item.quantity}
                    </Text>
                    <View style={styles.priceRow}>
                      <Text style={styles.priceValue}>
                        {formatCents(item.price?.currentCents)}
                      </Text>
                      {item.price?.listPriceCents &&
                        item.price.listPriceCents > item.price.currentCents && (
                          <Text style={styles.strikePrice}>
                            {formatCents(item.price.listPriceCents)}
                          </Text>
                        )}
                    </View>
                    <Text style={styles.cardMuted} numberOfLines={1}>
                      {item.offer?.deliveryEstimate}
                    </Text>
                  </View>
                </View>
              </View>
            ))
          )}

          {adapter.items.length > 0 && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Quote Checkout Dry Run"
              disabled={session.status === 'busy'}
              onPress={() => void handleDryRunQuote()}
              style={({ pressed }) => [
                styles.fullPrimaryButton,
                session.status === 'busy' && styles.disabledAction,
                pressed && styles.pressed,
              ]}>
              {activeAction === 'quote' ? (
                <ActivityIndicator size="small" color={colors.onStrong} />
              ) : (
                <Text style={styles.primaryActionLabel}>Quote Checkout (Dry Run)</Text>
              )}
            </Pressable>
          )}
        </View>

        {lastQuoteResult && (
          <View style={styles.section}>
            <Text style={styles.sectionHeading}>Checkout Safety Gate</Text>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>
                {lastQuoteResult.requiresSignIn
                  ? 'Halted at Amazon Sign-In (/ap/signin)'
                  : lastQuoteResult.haltedAt === 'checkout_review'
                    ? 'Halted at Checkout Review'
                    : `Halted (${lastQuoteResult.haltedAt})`}
              </Text>
              <Text style={styles.cardMuted}>
                Safety lock active: dryRun=true · Final Place Order never clicked
              </Text>

              {lastQuoteResult.quote && (
                <View style={styles.quoteSummary}>
                  <View style={styles.quoteLine}>
                    <Text style={styles.cardMuted}>Items ({lastQuoteResult.quote.quantity})</Text>
                    <Text style={styles.quoteAmount}>
                      {formatCents(lastQuoteResult.quote.subtotalCents)}
                    </Text>
                  </View>
                  <View style={styles.quoteLine}>
                    <Text style={styles.cardMuted}>Shipping</Text>
                    <Text style={styles.quoteAmount}>
                      {lastQuoteResult.quote.shippingCents === 0
                        ? 'Free'
                        : formatCents(lastQuoteResult.quote.shippingCents)}
                    </Text>
                  </View>
                  <View style={styles.quoteLine}>
                    <Text style={styles.cardMuted}>Estimated tax</Text>
                    <Text style={styles.quoteAmount}>
                      {formatCents(lastQuoteResult.quote.taxCents)}
                    </Text>
                  </View>
                  <View style={[styles.quoteLine, styles.quoteTotalLine]}>
                    <Text style={styles.cardTitle}>
                      {lastQuoteResult.liveTotalVerified ? 'Order total' : 'Estimated total'}
                    </Text>
                    <Text style={styles.cardTitle}>
                      {formatCents(lastQuoteResult.quote.totalCents)}
                    </Text>
                  </View>
                  <Text style={styles.cardMuted}>
                    {lastQuoteResult.quote.deliveryEstimate} · {lastQuoteResult.quote.returnSummary}
                  </Text>
                </View>
              )}

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="View Live Browser State"
                onPress={() => session.openBrowserSheet(lastQuoteResult.currentUrl)}
                style={({ pressed }) => [
                  styles.secondaryFullButton,
                  pressed && styles.pressed,
                ]}>
                <Text style={styles.secondaryButtonLabel}>Inspect Live Amazon Browser</Text>
              </Pressable>
            </View>
          </View>
        )}

        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionHeading}>
              Synced Amazon Orders ({adapter.purchases.length})
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Sync Amazon Orders"
              disabled={session.status === 'busy'}
              onPress={() => void handleSyncOrders()}
              style={({ pressed }) => [
                styles.secondaryButton,
                session.status === 'busy' && styles.disabledAction,
                pressed && styles.pressed,
              ]}>
              {activeAction === 'orders' ? (
                <ActivityIndicator size="small" color={colors.text} />
              ) : (
                <Text style={styles.secondaryButtonLabel}>Sync Orders</Text>
              )}
            </Pressable>
          </View>

          {adapter.purchases.map((purchase) => (
            <View key={purchase.orderId} style={styles.card}>
              <Text style={styles.cardTitle} numberOfLines={2}>
                {purchase.quote.productTitle}
              </Text>
              <Text style={styles.cardMuted}>
                {purchase.shipment?.status ?? 'ordered'}
                {purchase.shipment?.eta ? ` · ETA ${purchase.shipment.eta}` : ''} ·{' '}
                {formatCents(purchase.quote.totalCents)}
              </Text>
              {purchase.shipment?.events && purchase.shipment.events.length > 0 && (
                <Text style={styles.cardMuted} numberOfLines={2}>
                  Latest scan:{' '}
                  {purchase.shipment.events[purchase.shipment.events.length - 1]?.description}
                </Text>
              )}
            </View>
          ))}
        </View>

        {errorMessage && (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function createHarnessStyles(colors: Palette) {
  return StyleSheet.create({
    fabWrapper: {
      position: 'absolute',
      right: Spacing.lg,
      zIndex: 900,
    },
    fabButton: {
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.pill,
    },
    fabLabel: {
      ...Type.secondary,
      color: colors.text,
      fontWeight: '600',
    },
    fullScreen: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 950,
      backgroundColor: colors.background,
    },
    topBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    topBarLeft: {
      flex: 1,
      gap: 2,
    },
    topBarActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.md,
    },
    title: {
      ...Type.headline,
      color: colors.text,
    },
    metaLine: {
      ...Type.secondary,
      color: colors.textSecondary,
    },
    secondaryButton: {
      backgroundColor: colors.control,
      paddingHorizontal: Spacing.md,
      paddingVertical: 7,
      borderRadius: Radius.pill,
    },
    secondaryButtonLabel: {
      ...Type.secondary,
      color: colors.text,
      fontWeight: '600',
    },
    plainClose: {
      paddingVertical: 6,
      paddingHorizontal: Spacing.xs,
    },
    plainCloseLabel: {
      ...Type.body,
      color: colors.textSecondary,
      fontWeight: '500',
    },
    scroll: {
      flex: 1,
    },
    scrollContent: {
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.lg,
      gap: Spacing.xxl,
    },
    section: {
      gap: Spacing.sm,
    },
    sectionHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    sectionHeading: {
      ...Type.secondary,
      fontWeight: '600',
      color: colors.textSecondary,
    },
    sectionCaption: {
      ...Type.secondary,
      color: colors.textSecondary,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: Radius.tile,
      padding: Spacing.md,
      gap: Spacing.sm,
    },
    emptyCard: {
      backgroundColor: colors.surface,
      borderRadius: Radius.tile,
      padding: Spacing.lg,
    },
    cardRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.md,
    },
    cartItemRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: Spacing.md,
    },
    productThumb: {
      width: 60,
      height: 60,
      borderRadius: Spacing.sm,
      backgroundColor: colors.imageTile,
    },
    productThumbPlaceholder: {
      width: 60,
      height: 60,
      borderRadius: Spacing.sm,
      backgroundColor: colors.control,
    },
    cardInfo: {
      flex: 1,
      gap: Spacing.xs,
    },
    cardTitle: {
      ...Type.body,
      fontWeight: '600',
      color: colors.text,
    },
    cardMuted: {
      ...Type.secondary,
      color: colors.textSecondary,
    },
    priceRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: 6,
      marginTop: 2,
    },
    priceValue: {
      ...Type.body,
      fontWeight: '700',
      color: colors.text,
    },
    strikePrice: {
      ...Type.secondary,
      color: colors.textTertiary,
      textDecorationLine: 'line-through',
    },
    primaryAction: {
      backgroundColor: colors.strong,
      minWidth: 68,
      height: 36,
      paddingHorizontal: Spacing.lg,
      borderRadius: Radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    fullPrimaryButton: {
      backgroundColor: colors.strong,
      height: 46,
      borderRadius: Radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: Spacing.xs,
    },
    primaryActionLabel: {
      ...Type.secondary,
      color: colors.onStrong,
      fontWeight: '600',
    },
    secondaryFullButton: {
      backgroundColor: colors.control,
      height: 40,
      borderRadius: Radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: Spacing.xs,
    },
    disabledAction: {
      opacity: 0.5,
    },
    pressed: {
      opacity: 0.7,
    },
    quoteSummary: {
      gap: 6,
      paddingTop: 6,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
    },
    quoteLine: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    quoteTotalLine: {
      paddingTop: 6,
      marginTop: 2,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
    },
    quoteAmount: {
      ...Type.secondary,
      color: colors.text,
      fontWeight: '500',
    },
    errorCard: {
      backgroundColor: colors.control,
      borderRadius: Radius.tile,
      padding: Spacing.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    errorText: {
      ...Type.secondary,
      color: colors.text,
    },
  });
}
