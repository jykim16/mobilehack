import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ItemCard } from '@/components/item-card';
import { PillButton } from '@/components/pill-button';
import { PriceText } from '@/components/product-bits';
import { QuantityStepper } from '@/components/quantity-stepper';
import { RetailerHeader } from '@/components/retailer-header';
import { Shimmer, SkeletonBlock } from '@/components/skeleton';
import { Wordmark } from '@/components/wordmark';
import { Radius, Spacing, Type, tabularNumbers, useColors, useThemedStyles, type Palette } from '@/constants/theme';
import { useAddFromInput } from '@/data/add-item';
import { useCheckout } from '@/data/checkout';
import { errorMessage, itemOffer, useShop } from '@/data/shop-store';
import type { CartItem, QueryAlternative } from '@/data/types';
import { formatPrice } from '@/lib/format';

type CheckoutState = { status: 'placing' } | { status: 'error'; message: string };

/** An item the shopper just added from the input, pinned to the top until enrichment finishes. */
interface Add {
  key: string;
  itemId: string | null;
  /** Set once listItems has returned the item, so a later absence means it was removed. */
  seen: boolean;
  alternatives: QueryAlternative[];
  /** The item a Did-you-mean tap is replacing, hidden while cart:removeItem lands. */
  replacing: string | null;
}

const gathering = (item: CartItem) => item.enrichmentStatus === 'resolving' || item.enrichmentStatus === 'enriching';

export default function CartScreen() {
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const overBar = Platform.OS === 'ios' ? insets.bottom : 0;
  const { ready, error, items, live, addItem, setQuantity, removeItem, loadDemoCart } = useShop();
  const checkoutItem = useCheckout();
  const addFromInput = useAddFromInput();
  const [adds, setAdds] = useState<Add[]>([]);
  const [addError, setAddError] = useState<string | null>(null);
  const inFlight = useRef(new Set<string>());
  const [checkouts, setCheckouts] = useState<Record<string, CheckoutState>>({});
  const [toast, setToast] = useState(false);
  const [loadingDemo, setLoadingDemo] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(false), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const [reconciledItems, setReconciledItems] = useState(items);
  if (reconciledItems !== items) {
    setReconciledItems(items);
    setAdds(reconcileAdds(adds, items));
  }

  const unpin = (itemId: string) => setAdds((current) => current.filter((add) => add.itemId !== itemId));

  const updateAdd = (key: string, fields: Partial<Add>) =>
    setAdds((current) => current.map((add) => (add.key === key ? { ...add, ...fields } : add)));

  const track = async (key: string, start: () => Promise<{ itemId: string; alternatives: QueryAlternative[] }>) => {
    try {
      const { itemId, alternatives } = await start();
      updateAdd(key, { itemId, alternatives: alternatives.slice(0, 3) });
    } catch (e) {
      setAdds((current) => current.filter((add) => add.key !== key));
      setAddError(errorMessage(e));
    }
  };

  const submitAdd = (text: string) => {
    const key = `add-${Date.now()}-${adds.length}`;
    setAddError(null);
    setAdds((current) => [
      { key, itemId: null, seen: false, alternatives: [], replacing: null },
      ...reconcileAdds(
        current.map((add) => ({ ...add, alternatives: [] })),
        items
      ),
    ]);
    track(key, () => addFromInput(text));
  };

  const chooseAlternative = (add: Add, alternative: QueryAlternative) => {
    const original = add.itemId;
    setAddError(null);
    updateAdd(add.key, { itemId: null, seen: false, alternatives: [], replacing: original });
    track(add.key, async () => {
      const itemId = await addItem(alternative.url);
      if (original) {
        await removeItem(original).catch(() => {
          updateAdd(add.key, { replacing: null });
          setAddError("Couldn't remove the first match. Remove it from your cart.");
        });
      }
      return { itemId, alternatives: [] };
    });
  };

  const pinned = new Set(adds.flatMap((add) => [add.itemId, add.replacing]).filter((id): id is string => id !== null));
  const listed = items.filter((item) => !pinned.has(item.id));

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
    setToast(false);
    setCheckout(item.id, { status: 'placing' });
    try {
      await checkoutItem(item);
      unpin(item.id);
      setCheckout(item.id, null);
      setToast(true);
    } catch (e) {
      setCheckout(item.id, { status: 'error', message: errorMessage(e) });
    } finally {
      inFlight.current.delete(item.id);
    }
  };

  const renderItem = (key: string, item: CartItem | undefined) => {
    const state = item ? checkouts[item.id] : undefined;
    const placing = state?.status === 'placing';
    const loading = !item || gathering(item);
    return (
      <Animated.View key={key} entering={FadeIn} exiting={FadeOut} layout={LinearTransition} style={placing && styles.placing}>
        <ItemCard
          title={item?.product?.title ?? (loading ? null : (item?.url ?? null))}
          subtitle={item?.variant?.label ?? null}
          imageUrl={item?.product?.imageUrl}
          gathering={loading}
          onOpen={item ? () => router.push({ pathname: '/item/[id]', params: { id: item.id } }) : undefined}
          footer={
            <View style={styles.footer}>
              {state?.status === 'error' && <Text style={styles.error}>{state.message}</Text>}
              <View style={styles.actions}>
                {item ? (
                  <QuantityStepper
                    quantity={item.quantity}
                    onChange={(quantity) => setQuantity(item.id, quantity)}
                    onRemove={() => {
                      unpin(item.id);
                      return removeItem(item.id);
                    }}
                  />
                ) : (
                  <Shimmer>
                    <SkeletonBlock width={112} height={36} radius={Radius.pill} />
                  </Shimmer>
                )}
                {item && !(loading && !itemOffer(item)) ? (
                  <Animated.View entering={FadeIn.duration(300)}>
                    <PillButton
                      label={placing ? 'Placing order…' : state?.status === 'error' ? 'Try again' : 'Checkout'}
                      variant="strong"
                      size="small"
                      loading={placing}
                      disabled={!canBuy(item) || placingAll}
                      onPress={() => checkout(item)}
                    />
                  </Animated.View>
                ) : (
                  <Shimmer>
                    <SkeletonBlock width={104} height={36} radius={Radius.pill} />
                  </Shimmer>
                )}
              </View>
            </View>
          }>
          <CardPrice item={item} />
        </ItemCard>
      </Animated.View>
    );
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
      <Wordmark style={styles.title} />
      {ready && !error && <AddBar onSubmit={submitAdd} error={addError} />}
      {error ? (
        <View style={styles.empty}>
          <Text style={styles.emptyBody}>{error}</Text>
        </View>
      ) : !ready ? null : items.length === 0 && adds.length === 0 ? (
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
        <ScrollView contentContainerStyle={[styles.list, { paddingBottom: 96 }]} contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled">
          {adds.map((add) => {
            const item = add.itemId ? items.find((i) => i.id === add.itemId) : undefined;
            const offer = item ? (itemOffer(item) ?? item.offer) : null;
            return (
              <Animated.View key={add.key} style={styles.card} entering={FadeIn} exiting={FadeOut} layout={LinearTransition}>
                {offer ? (
                  <Animated.View entering={FadeIn.duration(300)}>
                    <RetailerHeader retailer={offer.retailer} retailerName={offer.retailerName} detail={offer.deliveryEstimate} />
                  </Animated.View>
                ) : (
                  <Shimmer style={styles.headerSkeleton}>
                    <SkeletonBlock width={36} height={36} radius={Radius.pill} />
                    <View style={styles.headerSkeletonText}>
                      <SkeletonBlock width={110} height={16} />
                      <SkeletonBlock width={170} height={12} />
                    </View>
                  </Shimmer>
                )}
                {renderItem(add.key + '-item', item)}
                {add.alternatives.length > 0 && (
                  <Animated.View entering={FadeIn} style={styles.alternatives}>
                    <Text style={styles.alternativesTitle}>Did you mean</Text>
                    {add.alternatives.map((alternative) => (
                      <Pressable
                        key={alternative.url}
                        accessibilityRole="button"
                        onPress={() => chooseAlternative(add, alternative)}
                        style={({ pressed }) => [styles.alternative, pressed && styles.alternativePressed]}>
                        <Text style={styles.alternativeTitle} numberOfLines={1}>
                          {alternative.title}
                        </Text>
                        <Text style={styles.alternativeMeta}>
                          {[alternative.retailer, alternative.priceCents !== null ? formatPrice(alternative.priceCents) : null].filter(Boolean).join(' · ')}
                        </Text>
                      </Pressable>
                    ))}
                  </Animated.View>
                )}
              </Animated.View>
            );
          })}
          {groupByRetailer(listed).map(({ retailer, retailerName, deliveryEstimate, items: groupItems }) => (
            <Animated.View key={retailer} style={styles.card} exiting={FadeOut} layout={LinearTransition}>
              <RetailerHeader retailer={retailer} retailerName={retailerName} detail={deliveryEstimate} />
              {groupItems.map((item) => renderItem(item.id, item))}
            </Animated.View>
          ))}
        </ScrollView>
      )}

      {ready && items.length > 0 && (
        <View style={[styles.checkoutBar, { bottom: overBar }]}>
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
        <Animated.View entering={FadeInDown} exiting={FadeOut} style={[styles.toastWrap, { bottom: 88 + overBar }]}>
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

/** Unpins adds whose item finished enriching (and has no suggestions left) or has left the cart. */
function reconcileAdds(adds: Add[], items: CartItem[]): Add[] {
  return adds.flatMap((add) => {
    const item = add.itemId ? items.find((i) => i.id === add.itemId) : undefined;
    if (!item) return add.seen ? [] : [add];
    if (!gathering(item) && add.alternatives.length === 0) return [];
    const replacing = add.replacing && items.some((i) => i.id === add.replacing) ? add.replacing : null;
    return [{ ...add, seen: true, replacing }];
  });
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

function CardPrice({ item }: { item: CartItem | undefined }) {
  const styles = useThemedStyles(createStyles);
  const offer = item ? itemOffer(item) : null;
  if (offer) {
    return (
      <Animated.View entering={FadeIn.duration(300)}>
        <PriceText priceCents={offer.priceCents} listPriceCents={offer.listPriceCents} />
      </Animated.View>
    );
  }
  if (!item || gathering(item)) {
    return (
      <Shimmer style={styles.priceSkeleton}>
        <SkeletonBlock width={76} height={18} />
      </Shimmer>
    );
  }
  const note = item.offerAvailability?.note;
  return note ? (
    <Text style={styles.note} numberOfLines={2}>
      {note}
    </Text>
  ) : null;
}

/** One row: a product title or link, and a round + that adds it. Return submits too. */
function AddBar({ onSubmit, error }: { onSubmit: (text: string) => void; error: string | null }) {
  const Colors = useColors();
  const styles = useThemedStyles(createStyles);
  const [text, setText] = useState('');
  const submit = () => {
    const value = text.trim();
    if (!value) return;
    setText('');
    Keyboard.dismiss();
    onSubmit(value);
  };
  return (
    <View style={styles.addBar}>
      <View style={styles.addRow}>
        <TextInput
          value={text}
          onChangeText={setText}
          onSubmitEditing={submit}
          placeholder="Add product title or URL"
          placeholderTextColor={Colors.textTertiary}
          returnKeyType="go"
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.addInput}
          accessibilityLabel="Add product title or URL"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add to cart"
          onPress={submit}
          hitSlop={6}
          style={({ pressed }) => [styles.addButton, pressed && styles.addButtonPressed]}>
          <Ionicons name="add" size={24} color={Colors.onAccent} />
        </Pressable>
      </View>
      {error && (
        <Animated.Text entering={FadeIn} style={styles.addError}>
          {error}
        </Animated.Text>
      )}
    </View>
  );
}

const createStyles = (Colors: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.background },
  addBar: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm, gap: Spacing.xs },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  addInput: {
    ...Type.body,
    flex: 1,
    height: 44,
    paddingHorizontal: Spacing.lg,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surface,
    color: Colors.text,
  },
  addButton: { width: 44, height: 44, borderRadius: Radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.accent },
  addButtonPressed: { opacity: 0.8 },
  addError: { ...Type.secondary, color: Colors.textSecondary, paddingHorizontal: Spacing.lg },
  headerSkeleton: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  headerSkeletonText: { gap: 6 },
  priceSkeleton: { paddingVertical: 2 },
  alternatives: { gap: Spacing.sm },
  alternativesTitle: { ...Type.secondary, color: Colors.textTertiary },
  alternative: { gap: 1 },
  alternativePressed: { opacity: 0.6 },
  alternativeTitle: { ...Type.body, color: Colors.text },
  alternativeMeta: { ...Type.secondary, color: Colors.textSecondary },
  title: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.md },
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
