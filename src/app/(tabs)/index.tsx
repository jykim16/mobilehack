import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ItemCard } from '@/components/item-card';
import { PillButton } from '@/components/pill-button';
import { PriceText } from '@/components/product-bits';
import { QuantityStepper } from '@/components/quantity-stepper';
import { RetailerHeader } from '@/components/retailer-header';
import { Radius, Spacing, Type, tabularNumbers, useThemedStyles, type Palette } from '@/constants/theme';
import { useCheckout } from '@/data/checkout';
import { errorMessage, itemOffer, useShop } from '@/data/shop-store';
import type { CartItem } from '@/data/types';
import { formatPrice } from '@/lib/format';

type CheckoutState = { status: 'placing' } | { status: 'error'; message: string };

export default function CartScreen() {
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const { ready, error, items, live, setQuantity, removeItem, loadDemoCart } = useShop();
  const checkoutItem = useCheckout();
  const inFlight = useRef(new Set<string>());
  const [checkouts, setCheckouts] = useState<Record<string, CheckoutState>>({});
  const [toast, setToast] = useState(false);
  const [loadingDemo, setLoadingDemo] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(false), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const setCheckout = (itemId: string, state: CheckoutState | null) =>
    setCheckouts((current) => {
      const next = { ...current };
      if (state) next[itemId] = state;
      else delete next[itemId];
      return next;
    });

  const checkout = async (item: CartItem) => {
    if (inFlight.current.has(item.id)) return;
    inFlight.current.add(item.id);
    setCheckout(item.id, { status: 'placing' });
    try {
      await checkoutItem(item);
      setCheckout(item.id, null);
      setToast(true);
    } catch (e) {
      setCheckout(item.id, { status: 'error', message: errorMessage(e) });
    } finally {
      inFlight.current.delete(item.id);
    }
  };

  const buyable = items.filter((item) => canBuy(item) && checkouts[item.id]?.status !== 'placing');
  const placingAll = items.some((item) => checkouts[item.id]?.status === 'placing');
  const total = buyable.reduce((sum, item) => sum + (itemOffer(item)?.priceCents ?? 0) * item.quantity, 0);
  const count = buyable.reduce((sum, item) => sum + item.quantity, 0);

  const checkoutAll = async () => {
    for (const item of buyable) await checkout(item);
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top + Spacing.sm }]}>
      <Text style={styles.title} accessibilityRole="header">
        Cart
      </Text>
      {error ? (
        <View style={styles.empty}>
          <Text style={styles.emptyBody}>{error}</Text>
        </View>
      ) : !ready ? null : items.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Your cart is empty</Text>
          <Text style={styles.emptyBody}>Items you or your connected agents save show up here.</Text>
          {live && (
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              disabled={loadingDemo}
              onPress={() => {
                setLoadingDemo(true);
                loadDemoCart().finally(() => setLoadingDemo(false));
              }}>
              {({ pressed }) => (
                <Text style={[styles.quietAction, pressed && styles.quietActionPressed]}>
                  {loadingDemo ? 'Loading demo cart…' : 'Load demo cart'}
                </Text>
              )}
            </Pressable>
          )}
        </View>
      ) : (
        <ScrollView contentContainerStyle={[styles.list, { paddingBottom: 96 }]}>
          {groupByRetailer(items).map(({ retailer, retailerName, deliveryEstimate, items: groupItems }) => (
            <Animated.View key={retailer} style={styles.card} exiting={FadeOut} layout={LinearTransition}>
              <RetailerHeader retailer={retailer} retailerName={retailerName} detail={deliveryEstimate} />
              {groupItems.map((item) => {
                const state = checkouts[item.id];
                const placing = state?.status === 'placing';
                return (
                  <Animated.View key={item.id} entering={FadeIn} exiting={FadeOut} layout={LinearTransition} style={placing && styles.placing}>
                    <ItemCard
                      title={item.product?.title ?? item.url}
                      subtitle={item.variant?.label ?? null}
                      imageUrl={item.product?.imageUrl}
                      onOpen={() => router.push({ pathname: '/item/[id]', params: { id: item.id } })}
                      footer={
                        <View style={styles.footer}>
                          {state?.status === 'error' && <Text style={styles.error}>{state.message}</Text>}
                          <View style={styles.actions}>
                            <QuantityStepper
                              quantity={item.quantity}
                              onChange={(quantity) => setQuantity(item.id, quantity)}
                              onRemove={() => removeItem(item.id)}
                            />
                            <PillButton
                              label={placing ? 'Placing order…' : state?.status === 'error' ? 'Try again' : 'Checkout'}
                              variant="strong"
                              size="small"
                              loading={placing}
                              disabled={!canBuy(item) || placingAll}
                              onPress={() => checkout(item)}
                            />
                          </View>
                        </View>
                      }>
                      <CardPrice item={item} />
                    </ItemCard>
                  </Animated.View>
                );
              })}
            </Animated.View>
          ))}
        </ScrollView>
      )}

      {ready && items.length > 0 && (
        <View style={styles.checkoutBar}>
          <PillButton
            variant="accent"
            icon="cart"
            label={placingAll ? 'Placing orders…' : `Checkout all (${count}) · ${formatPrice(total)}`}
            loading={placingAll}
            disabled={buyable.length === 0 || placingAll}
            onPress={checkoutAll}
          />
        </View>
      )}

      {toast && (
        <Animated.View entering={FadeInDown} exiting={FadeOut} style={styles.toastWrap}>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setToast(false);
              router.navigate('/purchases');
            }}
            style={styles.toast}>
            <Text style={styles.toastText}>
              Ordered · <Text style={styles.toastLink}>View in Purchases</Text>
            </Text>
          </Pressable>
        </Animated.View>
      )}
    </View>
  );
}

function groupByRetailer(items: CartItem[]) {
  const groups: { retailer: string; retailerName: string; deliveryEstimate: string; items: CartItem[] }[] = [];
  for (const item of items) {
    const offer = itemOffer(item) ?? item.offer;
    const retailer = offer?.retailer ?? 'unknown';
    const group = groups.find((g) => g.retailer === retailer);
    if (group) group.items.push(item);
    else
      groups.push({
        retailer,
        retailerName: offer?.retailerName ?? 'Other store',
        deliveryEstimate: offer?.deliveryEstimate ?? '',
        items: [item],
      });
  }
  return groups;
}

function canBuy(item: CartItem) {
  const offer = itemOffer(item);
  return Boolean(offer && offer.purchasable !== false);
}

function CardPrice({ item }: { item: CartItem }) {
  const styles = useThemedStyles(createStyles);
  const offer = itemOffer(item);
  if (offer) return <PriceText priceCents={offer.priceCents} listPriceCents={offer.listPriceCents} />;
  const note = item.offerAvailability?.note;
  return note ? (
    <Text style={styles.note} numberOfLines={2}>
      {note}
    </Text>
  ) : null;
}

const createStyles = (Colors: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.background },
  title: { ...Type.title, color: Colors.text, paddingHorizontal: Spacing.lg, paddingBottom: Spacing.md },
  list: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.md },
  card: { backgroundColor: Colors.surface, borderRadius: Radius.card, padding: Spacing.lg, gap: Spacing.xl },
  placing: { opacity: 0.6 },
  footer: { gap: Spacing.sm },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  error: { ...Type.secondary, color: Colors.textSecondary },
  note: { ...Type.secondary, color: Colors.textSecondary },
  checkoutBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    backgroundColor: Colors.background,
  },
  toastWrap: { position: 'absolute', left: Spacing.lg, right: Spacing.lg, bottom: 88, alignItems: 'center' },
  toast: {
    backgroundColor: Colors.control,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
  },
  toastText: { ...Type.body, ...tabularNumbers, color: Colors.text },
  toastLink: { fontWeight: '600' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.xxxl, gap: Spacing.sm },
  emptyTitle: { ...Type.title, color: Colors.text },
  emptyBody: { ...Type.body, color: Colors.textSecondary, textAlign: 'center' },
  quietAction: { ...Type.body, color: Colors.textSecondary, marginTop: Spacing.md },
  quietActionPressed: { color: Colors.text },
});
