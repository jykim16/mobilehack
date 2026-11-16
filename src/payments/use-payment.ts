import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { paymentCapability, type PaymentCapability } from './adapter';
import { openHostedCheckout } from './browser';
import { createPaymentController } from './controller';

export function usePayment(requestId: string, capability: PaymentCapability = paymentCapability, openBrowser: (url: string) => Promise<unknown> = openHostedCheckout) {
  const controller = useMemo(() => createPaymentController(requestId, capability, openBrowser), [requestId, capability, openBrowser]);
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    void controller.refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void controller.refresh();
    });
    return () => subscription.remove();
  }, [controller]);
  const refresh = useCallback(() => { void controller.refresh(); }, [controller]);
  return { view, refresh, open: controller.open };
}
