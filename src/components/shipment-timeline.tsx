import { StyleSheet, Text, View } from 'react-native';

import { Spacing, Type, tabularNumbers, useThemedStyles, type Palette } from '@/constants/theme';
import type { Shipment, ShipmentEvent } from '@/data/types';
import { etaDate, formatDateTime, formatShortDate } from '@/lib/format';

const labels = ['Ordered', 'Shipped', 'In transit', 'Out for delivery', 'Delivered'];

/**
 * Places carrier scans (oldest first) on five steps: the label scan is Ordered, the first shipped scan
 * is Shipped, later shipped scans are In transit, then Out for delivery and Delivered. The current step
 * comes from shipment.status, moving to In transit once a facility scan exists.
 */
export function shipmentProgress(shipment: Shipment | null, events: ShipmentEvent[]) {
  const latest: (ShipmentEvent | null)[] = labels.map(() => null);
  for (const event of [...events].sort((a, b) => a.occurredAt - b.occurredAt)) {
    const step =
      event.status === 'ordered'
        ? 0
        : event.status === 'out_for_delivery'
          ? 3
          : event.status === 'delivered'
            ? 4
            : latest[1] ? 2 : 1;
    latest[step] = event;
  }
  const reached = !shipment
    ? 0
    : shipment.status === 'shipped'
      ? latest[2] ? 2 : 1
      : { ordered: 0, out_for_delivery: 3, delivered: 4 }[shipment.status];
  return { latest, reached, label: labels[reached] };
}

export function ShipmentTimeline({
  placedAt,
  shipment,
  events,
}: {
  placedAt: number | null;
  shipment: Shipment | null;
  events: ShipmentEvent[];
}) {
  const styles = useThemedStyles(createStyles);
  const { latest, reached } = shipmentProgress(shipment, events);
  const delivered = shipment?.status === 'delivered';

  return (
    <View accessibilityRole="list">
      {labels.map((label, index) => {
        const event = latest[index];
        const state = index < reached || (delivered && index === reached) ? 'done' : index === reached ? 'current' : 'future';
        const eventAt = event?.occurredAt ?? (index === 0 ? placedAt : null);
        const time = eventAt
          ? formatDateTime(eventAt)
          : index === labels.length - 1 && shipment?.eta && state === 'future'
            ? `Expected ${formatShortDate(etaDate(shipment.eta))}`
            : null;
        const detail = event
          ? [event.description === label ? null : event.description, event.location].filter(Boolean).join(', ')
          : null;
        const last = index === labels.length - 1;
        return (
          <View key={label} style={styles.step} accessibilityLabel={[label, detail, time].filter(Boolean).join(', ')}>
            <View style={styles.rail}>
              <View
                style={[
                  styles.dot,
                  state === 'done' && styles.dotDone,
                  state === 'current' && styles.dotCurrent,
                  delivered && last && styles.dotDelivered,
                ]}
              />
              {!last && <View style={[styles.line, index < reached && styles.lineDone]} />}
            </View>
            <View style={[styles.body, !last && styles.bodySpacing]}>
              <View style={styles.labelRow}>
                <Text style={[styles.label, state === 'current' && styles.labelCurrent, state === 'future' && styles.future]}>
                  {label}
                </Text>
                {time && <Text style={[styles.time, state === 'future' && styles.future]}>{time}</Text>}
              </View>
              {detail && <Text style={styles.detail}>{detail}</Text>}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const DOT = 12;

const createStyles = (Colors: Palette) => StyleSheet.create({
  step: { flexDirection: 'row', gap: Spacing.md },
  rail: { width: DOT + 4, alignItems: 'center', paddingTop: 4 },
  dot: {
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    borderWidth: 2,
    borderColor: Colors.textTertiary,
  },
  dotDone: { backgroundColor: Colors.text, borderColor: Colors.text },
  dotCurrent: {
    width: DOT + 4,
    height: DOT + 4,
    borderRadius: (DOT + 4) / 2,
    marginTop: -2,
    backgroundColor: Colors.accent,
    borderColor: Colors.accent,
  },
  dotDelivered: { backgroundColor: Colors.success, borderColor: Colors.success },
  line: { flex: 1, width: 2, marginVertical: 4, borderRadius: 1, backgroundColor: Colors.control },
  lineDone: { backgroundColor: Colors.textSecondary },
  body: { flex: 1, gap: 2 },
  bodySpacing: { paddingBottom: Spacing.xl },
  labelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: Spacing.md },
  label: { ...Type.body, color: Colors.text },
  labelCurrent: { fontWeight: '600' },
  future: { color: Colors.textTertiary },
  time: { ...Type.secondary, ...tabularNumbers, color: Colors.textSecondary },
  detail: { ...Type.secondary, color: Colors.textSecondary },
});
