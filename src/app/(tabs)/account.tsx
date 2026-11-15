import { useAuthActions } from '@convex-dev/auth/react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import type { ComponentProps } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Radius, Spacing, Type, useColors, useThemedStyles, type Palette } from '@/constants/theme';
import { convexConfigured, rememberAccountEmail, useAccountEmail } from '@/lib/session';

export default function AccountScreen() {
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();

  return (
    <ScrollView style={styles.screen} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={[styles.content, { paddingTop: insets.top + Spacing.sm }]}>
      <Text style={styles.title} accessibilityRole="header">
        Account
      </Text>
      {convexConfigured ? <SignedInSection /> : <Text style={styles.muted}>Offline demo. Nothing is saved to an account.</Text>}

      <View style={styles.group}>
        <Row icon="sparkles-outline" title="Connect an agent" detail="Let an AI agent add to your cart over MCP" onPress={() => router.push('/connect-agent')} />
        <View style={styles.hairline} />
        <Row icon="logo-amazon" title="Connect Amazon" detail="Coming soon" />
      </View>
    </ScrollView>
  );
}

function SignedInSection() {
  const styles = useThemedStyles(createStyles);
  const email = useAccountEmail();
  const { signOut } = useAuthActions();
  return (
    <View style={styles.group}>
      <View style={styles.identity}>
        <Text style={styles.rowTitle}>{email ?? 'Signed in'}</Text>
        <Text style={styles.muted}>Signed in with email</Text>
      </View>
      <View style={styles.hairline} />
      <Pressable
        accessibilityRole="button"
        onPress={async () => {
          await rememberAccountEmail(null);
          await signOut();
        }}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
        <Text style={styles.signOut}>Sign out</Text>
      </Pressable>
    </View>
  );
}

function Row({
  icon,
  title,
  detail,
  onPress,
}: {
  icon: ComponentProps<typeof Ionicons>['name'];
  title: string;
  detail: string;
  onPress?: () => void;
}) {
  const Colors = useColors();
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !onPress }}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <View style={styles.icon}>
        <Ionicons name={icon} size={18} color={Colors.text} />
      </View>
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, !onPress && styles.disabled]}>{title}</Text>
        <Text style={styles.muted}>{detail}</Text>
      </View>
      {onPress && <Ionicons name="chevron-forward" size={18} color={Colors.textTertiary} />}
    </Pressable>
  );
}

const createStyles = (Colors: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.background },
  content: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.xxl, gap: Spacing.xxl },
  title: { ...Type.title, color: Colors.text },
  group: { backgroundColor: Colors.surface, borderRadius: Radius.card, paddingHorizontal: Spacing.lg },
  identity: { paddingVertical: Spacing.lg, gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.lg },
  pressed: { opacity: 0.6 },
  icon: {
    width: 32,
    height: 32,
    borderRadius: Radius.pill,
    backgroundColor: Colors.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: { flex: 1, gap: 1 },
  rowTitle: { ...Type.body, fontWeight: '600', color: Colors.text },
  disabled: { color: Colors.textSecondary },
  muted: { ...Type.secondary, color: Colors.textSecondary },
  signOut: { ...Type.body, color: Colors.textSecondary },
  hairline: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.hairline },
});
