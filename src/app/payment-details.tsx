import { Redirect } from 'expo-router';

import { whopPreviewEnabled } from '@/payments/preview-config';
import { ReadOnlyPaymentDetails } from '@/payments/read-only-details';

export default function PaymentDetails() {
  if (!whopPreviewEnabled) return <Redirect href="/" />;
  return <ReadOnlyPaymentDetails />;
}
