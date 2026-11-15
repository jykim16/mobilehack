import { useMemo } from 'react';
import { Platform, useColorScheme, type TextStyle } from 'react-native';

const DarkColors = {
  background: '#000000',
  surface: '#1C1C1E',
  sheet: '#1C1C1E',
  control: '#2C2C2E',
  controlPressed: '#3A3A3C',
  hairline: '#2C2C2E',
  imageTile: '#FFFFFF',
  text: '#FFFFFF',
  textSecondary: '#98989F',
  textTertiary: '#636366',
  accent: '#5433EB',
  accentPressed: '#4524DB',
  onAccent: '#FFFFFF',
  strong: '#FFFFFF',
  strongPressed: '#D8D8DC',
  onStrong: '#000000',
  success: '#30D158',
};

export type Palette = typeof DarkColors;

const LightColors: Palette = {
  background: '#FFFFFF',
  surface: '#F4F4F6',
  sheet: '#FFFFFF',
  control: '#E8E8EC',
  controlPressed: '#DCDCE1',
  hairline: '#E5E5EA',
  imageTile: '#FFFFFF',
  text: '#0B0B0F',
  textSecondary: '#6E6E73',
  textTertiary: '#A1A1A6',
  accent: '#5433EB',
  accentPressed: '#4524DB',
  onAccent: '#FFFFFF',
  strong: '#0B0B0F',
  strongPressed: '#3A3A3C',
  onStrong: '#FFFFFF',
  success: '#008552',
};

/** The palette for the device's current light or dark setting. */
export function useColors(): Palette {
  return useColorScheme() === 'light' ? LightColors : DarkColors;
}

/** Builds a StyleSheet from the current palette, rebuilt only when the device setting changes. */
export function useThemedStyles<T>(create: (colors: Palette) => T): T {
  const colors = useColors();
  return useMemo(() => create(colors), [create, colors]);
}

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const Radius = {
  tile: 16,
  card: 24,
  pill: 999,
} as const;

const fontFamily = Platform.select({ web: 'system-ui, -apple-system, sans-serif', default: undefined });

export const Type = {
  title: { fontFamily, fontSize: 22, lineHeight: 28, fontWeight: '600', letterSpacing: -0.4 },
  headline: { fontFamily, fontSize: 17, lineHeight: 22, fontWeight: '600', letterSpacing: -0.2 },
  body: { fontFamily, fontSize: 15, lineHeight: 21, fontWeight: '400' },
  secondary: { fontFamily, fontSize: 13, lineHeight: 18, fontWeight: '400' },
} satisfies Record<string, TextStyle>;

export const tabularNumbers: TextStyle = { fontVariant: ['tabular-nums'] };
