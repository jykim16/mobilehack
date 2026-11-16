import { Redirect } from 'expo-router';

import PaymentFixturePreview from '@/payments/fixture-preview';

export default function PaymentPreview() {
  if (!__DEV__ || process.env.EXPO_PUBLIC_PAYMENT_FIXTURES !== 'true') return <Redirect href="/" />;
  return <PaymentFixturePreview />;
}
