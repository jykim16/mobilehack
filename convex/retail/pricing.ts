export const SIMULATED_TAX_RATE = 0.08266;

export function estimateTotals(priceCents: number, shippingCents: number, quantity: number) {
  const subtotalCents = priceCents * quantity;
  const taxCents = Math.round(subtotalCents * SIMULATED_TAX_RATE);
  return {
    subtotalCents,
    taxCents,
    shippingCents,
    totalCents: subtotalCents + taxCents + shippingCents,
  };
}
