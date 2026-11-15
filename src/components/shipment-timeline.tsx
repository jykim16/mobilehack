import { StyleSheet, Text, View } from 'react-native';

import { Spacing, Type, tabularNumbers, useThemedStyles, type Palette } from '@/constants/theme';
import type { Shipment, ShipmentEvent, ShipmentStatus } from '@/data/types';
import { etaDate, formatDateTime, formatShortDate } from '@/lib/format';

const steps: { status: ShipmentStatus; label: string }[] = [
  { status: 'ordered', label: 'Ordered' },
  { status: 'shipped', label: 'Shipped' },
  { status: 'out_for_delivery', label: 'Out for delivery' },
  { status: 'delivered', label: 'Delivered' },
];

/**
 * The step comes from shipment.status alone. Carrier event statuses are free-form, so events are never
 * mapped onto steps; the newest one is shown as text under the current step.
 */
export function shipmentProgress(shipment: Shipment | null, events: ShipmentEvent[]) {
  const reached = shipment ? Math.max(steps.findIndex((step) => step.status === shipment.status), 0) : 0;
  const newest = events.reduce<ShipmentEvent | null>((found, event) => (!found || event.occurredAt > found.occurredAt ? event : found), null);
  return { reached, newest, label: steps[reached].label };
}

const eventLine = (event: ShipmentEvent) => [event.description, event.location].filter(Boolean).join(', ');

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
  const { reached, newest } = shipmentProgress(shipment, events);
  const delivered = shipment?.status === 'delivered';
  const history = [...events].sort((a, b) => b.occurredAt - a.occurredAt);

  return (
    <View style={styles.container}>
      <View accessibilityRole="list">
        {steps.map(({ label }, index) => {
          const state = index < reached || (delivered && index === reached) ? 'done' : index === reached ? 'current' : 'future';
          const last = index === steps.length - 1;
          const event = index === reached ? newest : null;
          const eventAt = index === 0 ? placedAt : (event?.occurredAt ?? null);
          const time = eventAt
            ? formatDateTime(eventAt)
            : last && shipment?.eta && state === 'future'
              ? `Expected ${formatShortDate(etaDate(shipment.eta))}`
              : null;
          const detail = event && index > 0 ? eventLine(event) : null;
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
      {history.length > 1 && (
        <View style={styles.history}>
          <Text style={styles.historyTitle}>Tracking updates</Text>
          {history.map((event) => (
            <View key={`${event.occurredAt}-${event.description}`} style={styles.labelRow}>
              <Text style={[styles.detail, styles.historyText]}>{eventLine(event)}</Text>
              <Text style={styles.time}>{formatDateTime(event.occurredAt)}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const DOT = 12;

const createStyles = (Colors: Palette) => StyleSheet.create({
  container: { gap: Spacing.xl },
  history: { gap: Spacing.sm },
  historyTitle: { ...Type.secondary, color: Colors.textTertiary },
  historyText: { flex: 1 },
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
