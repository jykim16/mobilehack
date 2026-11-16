import Constants from 'expo-constants';
import { channel } from 'expo-updates';

import { getTestUser } from './test-user';

export const testUser = getTestUser({
  enabled: process.env.EXPO_PUBLIC_TEST_USER_ENABLED,
  environment: Constants.expoConfig?.extra?.appEnvironment,
  channel,
  development: __DEV__,
  email: process.env.EXPO_PUBLIC_TEST_USER_EMAIL,
  password: process.env.EXPO_PUBLIC_TEST_USER_PASSWORD,
});
