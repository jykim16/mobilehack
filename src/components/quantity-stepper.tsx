import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Radius, Type, tabularNumbers, useColors, useThemedStyles, type Palette } from '@/constants/theme';

const MAX_QUANTITY = 10;

export function QuantityStepper({
  quantity,
  onChange,
  onRemove,
}: {
  quantity: number;
  onChange: (quantity: number) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const Colors = useColors();
  const styles = useThemedStyles(createStyles);
  const [pending, setPending] = useState(false);
  const atMax = quantity >= MAX_QUANTITY;
  const run = async (update: () => Promise<void>) => {
    setPending(true);
    try {
      await update();
    } finally {
      setPending(false);
    }
  };
  return (
    <View style={styles.container}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={quantity === 1 ? 'Remove item' : 'Decrease quantity'}
        disabled={pending}
        hitSlop={6}
        onPress={() => run(() => (quantity === 1 ? onRemove() : onChange(quantity - 1)))}
        style={styles.button}>
        <Ionicons name={quantity === 1 ? 'trash-outline' : 'remove'} size={16} color={Colors.text} />
      </Pressable>
      <Text style={styles.quantity}>{quantity}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Increase quantity"
        accessibilityState={{ disabled: atMax || pending }}
        disabled={atMax || pending}
        hitSlop={6}
        onPress={() => run(() => onChange(quantity + 1))}
        style={styles.button}>
        <Ionicons name="add" size={18} color={atMax ? Colors.textTertiary : Colors.text} />
      </Pressable>
    </View>
  );
}

const createStyles = (Colors: Palette) => StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 34,
    borderRadius: Radius.pill,
    backgroundColor: Colors.control,
    paddingHorizontal: 4,
  },
  button: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  quantity: { ...Type.body, ...tabularNumbers, fontWeight: '600', color: Colors.text, minWidth: 16, textAlign: 'center' },
});
