import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { CardBrandLogo, cardBrandName } from '@/components/card-brand-logo';
import { Radius, Spacing, Type, tabularNumbers, useColors, useThemedStyles, type Palette } from '@/constants/theme';
import { demoProfile } from '@/data/demo-profile';
import { formatPrice } from '@/lib/format';

export function CloseButton() {
  const Colors = useColors();
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      testID="close-details"
      accessibilityRole="button"
      accessibilityLabel="Close"
      hitSlop={8}
      onPress={() => router.back()}
      style={({ pressed }) => [styles.close, pressed && { backgroundColor: Colors.controlPressed }]}>
      <Ionicons name="close" size={20} color={Colors.text} />
    </Pressable>
  );
}

export function DetailSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: { label: string; onPress: () => void };
  children: ReactNode;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {action && (
          <Pressable accessibilityRole="button" hitSlop={8} onPress={action.onPress}>
            {({ pressed }) => <Text style={[styles.sectionAction, pressed && styles.sectionActionPressed]}>{action.label}</Text>}
          </Pressable>
        )}
      </View>
      {children}
    </View>
  );
}

export function DetailRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.row}>
      <Text style={strong ? styles.totalLabel : styles.rowLabel}>{label}</Text>
      <Text style={strong ? styles.totalValue : styles.rowValue}>{value}</Text>
    </View>
  );
}

/** Checkout-style receipt: item price × quantity, discount, subtotal, tax, delivery, and total. */
export function ReceiptRows({
  unitCents,
  listPriceCents,
  quantity,
  subtotalCents,
  taxCents,
  shippingCents,
  totalCents,
  currency,
}: {
  unitCents: number;
  listPriceCents: number | null;
  quantity: number;
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  totalCents: number;
  currency: string;
}) {
  const styles = useThemedStyles(createStyles);
  const priceCents = listPriceCents !== null && listPriceCents > unitCents ? listPriceCents : unitCents;
  const discountCents = (priceCents - unitCents) * quantity;
  return (
    <View style={styles.rows}>
      <DetailRow label={`${formatPrice(priceCents, currency)} × ${quantity}`} value={formatPrice(priceCents * quantity, currency)} />
      {discountCents > 0 && <DetailRow label="Discount" value={`−${formatPrice(discountCents, currency)}`} />}
      <DetailRow label="Subtotal" value={formatPrice(subtotalCents, currency)} />
      <DetailRow label="Estimated tax" value={formatPrice(taxCents, currency)} />
      <DetailRow label="Delivery" value={shippingCents === 0 ? 'Free' : formatPrice(shippingCents, currency)} />
      <View style={styles.hairline} />
      <DetailRow label="Total" value={formatPrice(totalCents, currency)} strong />
    </View>
  );
}

/** Payment card and delivery address from the demo profile; the backend stores neither. */
export function PaymentRows() {
  const Colors = useColors();
  const styles = useThemedStyles(createStyles);
  const { card, address } = demoProfile;
  return (
    <View style={styles.rows}>
      <Text style={styles.muted}>Demo card and address · Not used for this order</Text>
      <View style={styles.infoRow}>
        <CardBrandLogo brand={card.brand} />
        <View style={styles.infoText}>
          <Text style={styles.infoTitle}>
            {cardBrandName(card.brand)} •••• {card.last4}
          </Text>
          <Text style={styles.muted}>Demo card · Expires {card.expires}</Text>
        </View>
      </View>
      <View style={styles.infoRow}>
        <View style={styles.iconTile}>
          <Ionicons name="location-outline" size={18} color={Colors.text} />
        </View>
        <View style={styles.infoText}>
          <Text style={styles.infoTitle}>{address.name}</Text>
          <Text style={styles.muted}>
            {address.line1}, {address.city}, {address.region} {address.postalCode}
          </Text>
        </View>
      </View>
    </View>
  );
}

const createStyles = (Colors: Palette) => StyleSheet.create({
  close: {
    width: 40,
    height: 40,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  section: { backgroundColor: Colors.surface, borderRadius: Radius.card, padding: Spacing.lg, gap: Spacing.lg },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { ...Type.headline, color: Colors.text },
  sectionAction: { ...Type.body, color: Colors.textSecondary },
  sectionActionPressed: { color: Colors.text },
  rows: { gap: Spacing.md },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: Spacing.lg },
  rowLabel: { ...Type.body, color: Colors.textSecondary, flexShrink: 1 },
  rowValue: { ...Type.body, ...tabularNumbers, color: Colors.text, textAlign: 'right', flexShrink: 1 },
  totalLabel: { ...Type.headline, color: Colors.text },
  totalValue: { ...Type.headline, ...tabularNumbers, color: Colors.text },
  hairline: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.hairline },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  infoText: { flex: 1, gap: 1 },
  infoTitle: { ...Type.body, color: Colors.text },
  muted: { ...Type.secondary, color: Colors.textSecondary },
  iconTile: {
    width: 44,
    height: 28,
    borderRadius: 6,
    backgroundColor: Colors.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
