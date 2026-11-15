import Ionicons from '@expo/vector-icons/Ionicons';
import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';

import { Colors, Radius, Spacing, Type, tabularNumbers } from '@/constants/theme';

export const COMPOSER_HEIGHT = 52;

const liquidGlass = isLiquidGlassAvailable();

function Glass({ tint, style, children }: { tint?: string; style: StyleProp<ViewStyle>; children: ReactNode }) {
  if (liquidGlass) {
    return (
      <GlassView glassEffectStyle="regular" colorScheme="auto" tintColor={tint} isInteractive style={style}>
        {children}
      </GlassView>
    );
  }
  return (
    <BlurView intensity={40} tint="systemChromeMaterial" style={[style, styles.blurFallback]}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: tint ?? Colors.glassFallback }]} />
      {children}
    </BlurView>
  );
}

export function ChatComposer({
  value,
  onChangeText,
  onSend,
  canSend,
  cartCount,
  onOpenCart,
  bottomInset,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  canSend: boolean;
  cartCount: number;
  onOpenCart: () => void;
  bottomInset: number;
}) {
  return (
    <View pointerEvents="box-none" style={[styles.container, { paddingBottom: bottomInset }]}>
      <Glass style={styles.input}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          onSubmitEditing={onSend}
          placeholder="Ask or Search"
          placeholderTextColor={Colors.textSecondary}
          returnKeyType="send"
          style={styles.textInput}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send message"
          disabled={!canSend}
          onPress={onSend}
          style={[styles.send, { backgroundColor: canSend ? Colors.accent : 'transparent' }]}>
          <Ionicons name="arrow-up" size={18} color={canSend ? Colors.onAccent : Colors.textTertiary} />
        </Pressable>
      </Glass>
      <Pressable accessibilityRole="button" accessibilityLabel={`Cart, ${cartCount} items`} onPress={onOpenCart}>
        <Glass tint={Colors.glassAccentTint} style={[styles.cart, cartCount > 0 && styles.cartWithCount]}>
          <Ionicons name="cart" size={20} color={Colors.onAccent} />
          {cartCount > 0 && <Text style={styles.count}>{cartCount}</Text>}
        </Glass>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
  },
  blurFallback: { overflow: 'hidden' },
  input: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    height: COMPOSER_HEIGHT,
    borderRadius: Radius.pill,
    paddingLeft: Spacing.xl,
    paddingRight: 8,
  },
  textInput: { flex: 1, minWidth: 0, ...Type.body, fontSize: 16, color: Colors.text, height: COMPOSER_HEIGHT },
  send: { width: 36, height: 36, borderRadius: Radius.pill, alignItems: 'center', justifyContent: 'center' },
  cart: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minWidth: COMPOSER_HEIGHT,
    height: COMPOSER_HEIGHT,
    borderRadius: Radius.pill,
  },
  cartWithCount: { paddingHorizontal: Spacing.lg },
  count: { ...Type.headline, ...tabularNumbers, color: Colors.onAccent },
});
