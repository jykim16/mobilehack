import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)), 'react-native': 'react-native-web' } },
  test: { environment: 'node', include: ['src/payments/**/*.test.ts'] },
});
