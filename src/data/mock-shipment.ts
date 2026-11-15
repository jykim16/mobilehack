import { etaDate } from '@/lib/format';

import { demoProfile } from './demo-profile';
import type { Shipment, ShipmentEvent } from './types';

/**
 * Stand-in for shipment.events when a shipment has none, mirroring the backend's simulated scans:
 * label created (ordered), carrier possession and facility scans (shipped), out for delivery, delivered.
 * Events stop at the shipment's current status and are spread between the order time and its latest change.
 */

const origins: Record<string, string> = {
  amazon: 'Tracy, CA',
  bestbuy: 'Ontario, CA',
  target: 'Stockton, CA',
  rei: 'Sumner, WA',
  walmart: 'Merced, CA',
  nike: 'Memphis, TN',
};

const eventsReached: Record<Shipment['status'], number> = { ordered: 1, shipped: 4, out_for_delivery: 5, delivered: 6 };

export function mockShipmentEvents(placedAt: number, retailer: string, shipment: Shipment): ShipmentEvent[] {
  const origin = origins[retailer] ?? 'Reno, NV';
  const { city, region } = demoProfile.address;
  const home = `${city}, ${region}`;
  const sequence: Omit<ShipmentEvent, 'occurredAt'>[] = [
    { status: 'ordered', description: 'Shipping label created', location: origin },
    { status: 'shipped', description: 'Carrier in possession of item', location: origin },
    { status: 'shipped', description: 'Departed facility', location: origin },
    { status: 'shipped', description: 'Arrived at facility', location: 'Oakland, CA' },
    { status: 'out_for_delivery', description: 'Out for delivery', location: home },
    { status: 'delivered', description: 'Delivered, front door', location: home },
  ];
  const reached = sequence.slice(0, eventsReached[shipment.status]);

  const etaAt = (hours: number, minutes: number) => {
    if (!shipment.eta) return null;
    const date = etaDate(shipment.eta);
    date.setHours(hours, minutes);
    return date.getTime();
  };
  const lastAt =
    shipment.status === 'delivered' ? etaAt(14, 14) : shipment.status === 'out_for_delivery' ? etaAt(7, 42) : null;
  const end = lastAt && lastAt > placedAt && lastAt <= shipment.updatedAt ? lastAt : Math.max(shipment.updatedAt, placedAt);

  return reached.map((event, index) => ({
    ...event,
    occurredAt: placedAt + Math.round(((end - placedAt) * index) / Math.max(reached.length - 1, 1)),
  }));
}
