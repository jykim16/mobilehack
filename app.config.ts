import type { ConfigContext } from 'expo/config';
import { version } from 'expo/package.json';

export default ({ config }: ConfigContext) => ({
  ...config,
  extra: {
    ...config.extra,
    appEnvironment: process.env.EAS_BUILD_PROFILE
      ?? process.env.APP_ENV
      ?? (process.env.NODE_ENV === 'production' ? 'production' : 'development'),
  },
  runtimeVersion:
    process.env.CART_EXPO_GO_PREVIEW === '1'
      ? `exposdk:${version.split('.')[0]}.0.0`
      : config.runtimeVersion,
});
