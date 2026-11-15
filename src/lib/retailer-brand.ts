import type { Palette } from '@/constants/theme';

const brands: Record<string, { mark: string; background: string; foreground: string }> = {
  amazon: { mark: 'a', background: '#232F3E', foreground: '#FF9900' },
  bestbuy: { mark: 'BB', background: '#0A4ABF', foreground: '#FFE000' },
  nike: { mark: 'N', background: '#FFFFFF', foreground: '#111111' },
  target: { mark: 'T', background: '#CC0000', foreground: '#FFFFFF' },
  rei: { mark: 'REI', background: '#2E5E3A', foreground: '#FFFFFF' },
  walmart: { mark: 'W', background: '#0071DC', foreground: '#FFC220' },
};

export function retailerBrand(retailer: string, retailerName: string, Colors: Palette) {
  return brands[retailer] ?? { mark: retailerName.charAt(0).toUpperCase(), background: Colors.control, foreground: Colors.text };
}
