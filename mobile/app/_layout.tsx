import { Stack } from 'expo-router';
import { useEffect } from 'react';
import * as WebBrowser from 'expo-web-browser';

export default function RootLayout() {
  useEffect(() => { WebBrowser.maybeCompleteAuthSession(); }, []);
  return <Stack screenOptions={{ headerShown: false }} />;
}
