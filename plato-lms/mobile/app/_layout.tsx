import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

export default function RootLayout() {
  return <><StatusBar style="dark" backgroundColor="#f7f6f2" /><Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#f7f6f2' } }} /></>;
}
