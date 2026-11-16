import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { PillButton } from '@/components/pill-button';
import { Radius, Spacing, Type, tabularNumbers, useColors, useThemedStyles, type Palette } from '@/constants/theme';
import { formatDateTime, formatPrice } from '@/lib/format';

import { maskedCard, paymentCopy, type AccountBalance, type ApprovedQuote, type OrderStages } from './model';
import type { PaymentView } from './controller';

export function QuoteApproval({ approval, busy, onApprove }: { approval: ApprovedQuote; busy: boolean; onApprove: (approval: ApprovedQuote) => void }) {
  const styles = useThemedStyles(createStyles);
  const { quote } = approval;
  return (
    <View style={styles.card}>
      <Text style={styles.heading} accessibilityRole="header">Review your payment</Text>
      <Text style={styles.body}>{quote.productTitle}</Text>
      <Text style={styles.muted}>{[quote.variantLabel, `Qty ${quote.quantity}`, quote.seller].filter(Boolean).join(' · ')}</Text>
      <Text style={styles.amount}>{formatPrice(quote.totalCents, quote.currency)} {quote.currency}</Text>
      <Text style={styles.muted}>Includes {formatPrice(quote.taxCents, quote.currency)} tax and {formatPrice(quote.shippingCents, quote.currency)} delivery. {quote.deliveryEstimate}. {quote.returnSummary}</Text>
      <Text style={styles.muted}>You’re approving quote {approval.quoteVersion} for this request only. Card details are entered securely on Whop, never in Cart.</Text>
      <PillButton label="Approve and open secure checkout" variant="accent" loading={busy} onPress={() => onApprove({ ...approval, quote: { ...quote } })} />
    </View>
  );
}

export function PaymentStatusCard({ view, onRefresh }: { view: PaymentView; onRefresh: () => void }) {
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
  const snapshot = view.snapshot;
  const copy = snapshot ? paymentCopy[snapshot.status] : null;
  const card = snapshot ? maskedCard(snapshot.card) : null;
  return (
    <View style={styles.card}>
      <View accessibilityLiveRegion="polite" accessibilityState={{ busy: view.busy }} aria-busy={view.busy}>
        <Text style={styles.heading} accessibilityRole="header">{copy?.title ?? (view.busy ? 'Checking payment' : 'Payment unavailable')}</Text>
        <Text style={styles.muted}>{copy?.detail ?? 'No payment outcome has been confirmed.'}</Text>
      </View>
      {snapshot && <>
        {snapshot.sandbox && <Text style={styles.body}>Simulated card / Sandbox retailer charge</Text>}
        <Text style={styles.amount}>{formatPrice(snapshot.payment.amountCents, snapshot.payment.currency)} {snapshot.payment.currency}</Text>
        {snapshot.status === 'failed' && snapshot.failureReason && <Text style={styles.body}>{snapshot.failureReason}</Text>}
        {snapshot.card?.status === 'unsupported' && <Text style={styles.body}>Simulated retailer charge · Card issuing is not supported for this account.</Text>}
        {card && <Text style={styles.body}>{card}</Text>}
        <Text style={styles.muted}>Payment reference {snapshot.payment.paymentId}{'\n'}{snapshot.updatedAt === null ? 'Status update time unavailable' : `Updated ${formatDateTime(snapshot.updatedAt)}`}</Text>
      </>}
      {view.error && <Text style={styles.body} accessibilityRole="alert">{view.error}</Text>}
      {view.busy && <View style={styles.inline}><ActivityIndicator color={colors.textSecondary} /><Text style={styles.muted}>Checking secure payment status…</Text></View>}
      <PillButton label="Refresh payment status" onPress={onRefresh} disabled={view.busy} />
    </View>
  );
}

export function BalanceCard({ balance }: { balance: AccountBalance }) {
  const styles = useThemedStyles(createStyles);
  const amount = (cents: number | null) => cents === null || !balance.currency ? 'Unknown' : `${formatPrice(cents, balance.currency)} ${balance.currency}`;
  return (
    <View style={styles.card}>
      <Text style={styles.heading} accessibilityRole="header">Provider account balance</Text>
      {!balance.ownershipConfirmed && <Text style={styles.body}>Account ownership is not confirmed. These funds may be shared and are not confirmed as yours to spend.</Text>}
      <View><Text style={styles.muted}>Provider available</Text><Text style={styles.amount}>{amount(balance.availableCents)}</Text></View>
      <View style={styles.row}><Text style={styles.body}>Provider pending</Text><Text style={styles.body}>{amount(balance.pendingCents)}</Text></View>
      <Text style={styles.muted}>Pending funds are not available to spend.</Text>
      <Text style={styles.muted}>{balance.fetchedAt === null ? 'Provider balance freshness unknown.' : `Provider balance as of ${formatDateTime(balance.fetchedAt)}`}</Text>
      {balance.kycRequired && <Text style={styles.body}>Identity verification is required before withdrawal. Withdrawals are not available in Cart yet.</Text>}
    </View>
  );
}

export function OrderProgress({ stages }: { stages: OrderStages }) {
  const styles = useThemedStyles(createStyles);
  const orderPending = stages.orderStatus === 'unknown' ? 'Order outcome unconfirmed. Refresh or contact support; do not retry.'
    : stages.orderStatus === 'failed' ? 'Order failed. Contact support before trying again.'
    : stages.orderStatus === 'requote_required' ? 'Terms changed. Review and approve a new quote.'
    : stages.orderStatus === 'awaiting_payment' ? 'Awaiting payment confirmation'
    : 'Awaiting retailer confirmation';
  const rows = [
    { label: 'Payment confirmed', at: stages.paymentConfirmedAt, pending: 'Awaiting payment confirmation' },
    { label: stages.simulated ? 'Simulated retailer order placed' : 'Order placed', at: stages.orderPlacedAt, pending: orderPending },
    { label: stages.simulated ? 'Simulated shipment' : 'Shipment', at: stages.shipmentAt, pending: 'Awaiting shipment update' },
  ];
  return (
    <View style={styles.card}>
      <Text style={styles.heading} accessibilityRole="header">Order progress</Text>
      {rows.map(({ label, at, pending }, index) => <View key={label} style={styles.stage}>
        <View style={[styles.dot, at !== null && styles.confirmed]}><Text style={[styles.step, at !== null && styles.confirmedStep]}>{index + 1}</Text></View>
        <View style={styles.stageText}><Text style={styles.body}>{label}</Text><Text style={styles.muted}>{at === null ? pending : formatDateTime(at)}</Text></View>
      </View>)}
    </View>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: Radius.card, padding: Spacing.xl, gap: Spacing.lg },
  heading: { ...Type.headline, color: colors.text },
  body: { ...Type.body, color: colors.text },
  muted: { ...Type.secondary, color: colors.textSecondary, lineHeight: 20 },
  amount: { ...Type.title, ...tabularNumbers, fontSize: 30, lineHeight: 38, color: colors.text },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: Spacing.md, flexWrap: 'wrap' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  stage: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  stageText: { flex: 1, gap: Spacing.xs },
  dot: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.control, alignItems: 'center', justifyContent: 'center' },
  confirmed: { backgroundColor: colors.accent },
  step: { ...Type.secondary, color: colors.textSecondary },
  confirmedStep: { color: colors.onAccent },
});
