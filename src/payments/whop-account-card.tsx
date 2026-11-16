import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Radius, Spacing, Type, tabularNumbers, useColors, useThemedStyles, type Palette } from '@/constants/theme';

import { whopPreviewModel, type WhopPreviewModel } from './preview-model';
import { WhopLogo } from './whop-logo';

export function WhopAccountCard({ model = whopPreviewModel(), onDetails }: { model?: WhopPreviewModel; onDetails?: () => void }) {
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <WhopLogo />
        <Text style={styles.preview}>Preview only</Text>
      </View>
      <View style={styles.identity}>
        <Text style={styles.digits} accessibilityLabel={`Synthetic masked card ${model.maskedDigits}`}>{model.maskedDigits}</Text>
        <Text style={styles.disclosure}>Simulated card / Sandbox retailer charge</Text>
        <Text style={styles.muted}>Not a real issued or active card.</Text>
      </View>
      <View style={styles.status}>
        <Text style={styles.body}>{model.linked ? 'Sandbox account linked' : 'Account not linked'}</Text>
        <Text style={styles.muted}>{model.balance ? 'Provider balance in Payment details' : 'Balance unavailable'}</Text>
      </View>
      {onDetails && <Pressable accessibilityRole="button" accessibilityLabel="Payment details" onPress={onDetails} style={({ pressed }) => [styles.details, pressed && styles.pressed]}>
        <Text style={styles.action}>Payment details</Text>
        <Ionicons name="chevron-forward" size={17} color={colors.textSecondary} />
      </Pressable>}
    </View>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: Radius.card, padding: Spacing.xl, gap: Spacing.xl },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.lg },
  preview: { ...Type.secondary, color: colors.textSecondary },
  identity: { gap: Spacing.sm },
  digits: { ...Type.title, ...tabularNumbers, fontSize: 26, lineHeight: 34, letterSpacing: 2, color: colors.text },
  disclosure: { ...Type.body, fontWeight: '600', color: colors.text },
  muted: { ...Type.secondary, color: colors.textSecondary },
  status: { gap: Spacing.xs },
  body: { ...Type.body, color: colors.text },
  details: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline, paddingTop: Spacing.md },
  action: { ...Type.body, fontWeight: '600', color: colors.text },
  pressed: { opacity: 0.6 },
});
