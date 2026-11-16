import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CloseButton } from '@/components/order-details';
import { Radius, Spacing, Type, useThemedStyles, type Palette } from '@/constants/theme';

import { BalanceCard } from './components';
import { whopPreviewModel, type WhopPreviewModel } from './preview-model';
import { WhopAccountCard } from './whop-account-card';

export function ReadOnlyPaymentDetails({ model = whopPreviewModel() }: { model?: WhopPreviewModel }) {
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingTop: insets.top + Spacing.sm, paddingBottom: insets.bottom + Spacing.xxl }]}>
      <CloseButton />
      <Text style={styles.title} accessibilityRole="header">Payment details</Text>
      <WhopAccountCard model={model} />
      {model.balance ? <BalanceCard balance={model.balance} /> : <View style={styles.notice}>
        <Text style={styles.heading}>Balance unavailable</Text>
        <Text style={styles.muted}>Your Whop account link has not been verified. No shared account balance is shown as your money.</Text>
      </View>}
      <Text style={styles.muted}>This read-only preview does not check or start payments, issue a card, move funds, or place orders.</Text>
    </ScrollView>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: Spacing.lg, gap: Spacing.xl },
  title: { ...Type.title, color: colors.text },
  heading: { ...Type.headline, color: colors.text },
  notice: { backgroundColor: colors.surface, borderRadius: Radius.card, padding: Spacing.xl, gap: Spacing.sm },
  muted: { ...Type.secondary, color: colors.textSecondary },
});
