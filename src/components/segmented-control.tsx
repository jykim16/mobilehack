import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors, Radius, Type } from '@/constants/theme';

export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
}: {
  segments: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.track} accessibilityRole="tablist">
      {segments.map((segment) => {
        const selected = segment.value === value;
        return (
          <Pressable
            key={segment.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(segment.value)}
            style={[styles.segment, selected && styles.selected]}>
            <Text style={[styles.label, selected && styles.selectedLabel]}>{segment.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flex: 1,
    flexDirection: 'row',
    height: 40,
    padding: 3,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surface,
  },
  segment: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: Radius.pill },
  selected: { backgroundColor: Colors.control },
  label: { ...Type.body, fontWeight: '600', color: Colors.textSecondary },
  selectedLabel: { color: Colors.text },
});
