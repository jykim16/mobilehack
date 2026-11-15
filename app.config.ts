import type { ConfigContext } from 'expo/config';
import { version } from 'expo/package.json';

export default ({ config }: ConfigContext) => ({
  ...config,
  runtimeVersion:
    process.env.CART_EXPO_GO_PREVIEW === '1'
      ? `exposdk:${version.split('.')[0]}.0.0`
      : config.runtimeVersion,
});
