import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Spacing, Type, useThemedStyles, type Palette } from '@/constants/theme';

import { BalanceCard, OrderProgress, PaymentStatusCard, QuoteApproval } from './components';
import { fixtureApproval, fixtureBalance, fixturePayment, fixtureStages } from './fixtures';
import { paymentCopy, type PaymentStatus } from './model';
import type { PaymentCapability } from './adapter';
import { usePayment } from './use-payment';

const mockBrowser = async () => ({ type: 'dismiss' });
const statuses = Object.keys(paymentCopy) as PaymentStatus[];

export default function PaymentFixturePreview() {
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<PaymentStatus>('awaiting_payment');
  const [scenario, setScenario] = useState<'payment' | 'approval' | 'loading' | 'error'>('payment');
  const [balanceCase, setBalanceCase] = useState<'reported' | 'negative' | 'unknown'>('reported');
  const capability = useMemo<PaymentCapability>(() => ({
    available: true,
    reader: { checkoutOrigins: ['https://checkout.example.test'], readByRequestId: async () => ({ ...fixturePayment, status, failureReason: status === 'failed' ? 'The provider declined the payment.' : undefined }) },
  }), [status]);
  const { view, refresh, open } = usePayment(fixtureApproval.requestId, capability, mockBrowser);
  const paymentConfirmed = status === 'paid' || status === 'refunded';

  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingTop: insets.top + Spacing.xl }]}>
      <Text style={styles.fixture}>FIXTURE PREVIEW · NO LIVE PAYMENTS</Text>
      <Text style={styles.title} accessibilityRole="header">Payment & balance</Text>
      <Text style={styles.muted}>Sample data only. Buttons never contact Whop or create a payment.</Text>
      <View style={styles.options}>
        {(['payment', 'approval', 'loading', 'error'] as const).map((value) => <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: scenario === value }} onPress={() => setScenario(value)} style={[styles.option, scenario === value && styles.selected]}><Text style={styles.optionText}>{value}</Text></Pressable>)}
      </View>
      {scenario === 'payment' && <View style={styles.options}>
        {statuses.map((value) => <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: status === value }} onPress={() => setStatus(value)} style={[styles.option, status === value && styles.selected]}><Text style={styles.optionText}>{value.replaceAll('_', ' ')}</Text></Pressable>)}
      </View>}
      {scenario === 'approval' ? <QuoteApproval approval={fixtureApproval} busy={view.busy} onApprove={(approval) => { void open(approval); setScenario('payment'); }} /> : <PaymentStatusCard
        view={scenario === 'loading' ? { snapshot: null, busy: true, error: null } : scenario === 'error' ? { snapshot: { ...fixturePayment, status: 'unknown' }, busy: false, error: 'Unable to refresh payment status. The outcome is unconfirmed.' } : view}
        onRefresh={refresh}
      />}
      <OrderProgress stages={{ ...fixtureStages, paymentConfirmedAt: paymentConfirmed ? fixtureStages.paymentConfirmedAt : null, orderStatus: paymentConfirmed ? 'awaiting_client' : 'awaiting_payment' }} />
      <View style={styles.options}>
        {(['reported', 'negative', 'unknown'] as const).map((value) => <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: balanceCase === value }} onPress={() => setBalanceCase(value)} style={[styles.option, balanceCase === value && styles.selected]}><Text style={styles.optionText}>{value} balance</Text></Pressable>)}
      </View>
      <BalanceCard balance={balanceCase === 'negative' ? { ...fixtureBalance, availableCents: -275 } : balanceCase === 'unknown' ? { ...fixtureBalance, availableCents: null, pendingCents: null, fetchedAt: null } : fixtureBalance} />
    </ScrollView>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.xxxl, gap: Spacing.lg, width: '100%', maxWidth: 480, alignSelf: 'center' },
  fixture: { ...Type.secondary, fontWeight: '600', color: colors.accent },
  title: { ...Type.title, color: colors.text },
  muted: { ...Type.secondary, color: colors.textSecondary },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  option: { padding: Spacing.md, borderRadius: 12, backgroundColor: colors.surface, minHeight: 44, justifyContent: 'center' },
  selected: { backgroundColor: colors.control },
  optionText: { ...Type.secondary, color: colors.text },
});
