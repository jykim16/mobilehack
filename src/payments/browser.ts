import * as WebBrowser from 'expo-web-browser';

export async function openHostedCheckout(url: string): Promise<void> {
  await WebBrowser.openBrowserAsync(url);
}
