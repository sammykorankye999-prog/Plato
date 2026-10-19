import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView, type WebViewNavigation } from 'react-native-webview';

const serverUrl = process.env.EXPO_PUBLIC_PLATO_URL?.trim().replace(/\/$/, '') || '';
const serverHost = serverUrl ? new URL(serverUrl).host : '';
const localHttp = /^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2|192\.168\.)/.test(serverUrl);
const invalidHttp = serverUrl.startsWith('http://') && !localHttp;

export default function PlatoMobile() {
  const web = useRef<WebView>(null);
  const [back, setBack] = useState(false);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!back) return false;
      web.current?.goBack();
      return true;
    });
    return () => listener.remove();
  }, [back]);

  function permitNavigation(request: WebViewNavigation) {
    let target: URL;
    try { target = new URL(request.url); } catch { return false; }
    if (target.host === serverHost && (target.protocol === 'https:' || (localHttp && target.protocol === 'http:'))) return true;
    if (['https:', 'mailto:', 'tel:'].includes(target.protocol)) void Linking.openURL(request.url).catch(() => undefined);
    return false;
  }

  if (!serverUrl || invalidHttp) return <SafeAreaView style={styles.page}><View style={styles.card}>
    <Text style={styles.logo}>PLATO<Text style={styles.gold}>.</Text></Text>
    <Text style={styles.title}>Connect your learning space</Text>
    <Text style={styles.body}>{!serverUrl ? 'Set EXPO_PUBLIC_PLATO_URL in mobile/.env to your Flask server address, then restart Expo.' : 'Use HTTPS for a deployed server. HTTP is allowed only for local development addresses.'}</Text>
    <Text style={styles.hint}>On a phone, use your computer’s private Wi-Fi IP and port 5000. Both devices must share Wi-Fi.</Text>
  </View></SafeAreaView>;

  return <SafeAreaView style={styles.page}>
    <View style={styles.header}><View><Text style={styles.logo}>PLATO<Text style={styles.gold}>.</Text></Text><Text style={styles.caption}>LEARNING, AT YOUR PACE</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Reload Plato" style={styles.reload} onPress={() => { setError(''); setLoading(true); web.current?.reload(); }}><Text style={styles.reloadIcon}>↻</Text></Pressable></View>
    {loading && <View style={styles.loading}><ActivityIndicator color="#1e6554"/><Text style={styles.loadingText}>Opening your learning space…</Text></View>}
    {error ? <View style={styles.error}><Text style={styles.errorTitle}>Can’t reach Plato right now</Text><Text style={styles.errorText}>{error}</Text><Pressable style={styles.button} onPress={() => { setError(''); setLoading(true); web.current?.reload(); }}><Text style={styles.buttonText}>Try again</Text></Pressable></View> : null}
    <WebView
      ref={web}
      source={{ uri: serverUrl }}
      originWhitelist={['*']}
      onShouldStartLoadWithRequest={permitNavigation}
      onNavigationStateChange={state => setBack(state.canGoBack)}
      onLoadStart={() => { setLoading(true); setError(''); }}
      onLoadEnd={() => setLoading(false)}
      onLoadProgress={({ nativeEvent }) => setProgress(nativeEvent.progress)}
      onError={({ nativeEvent }) => { setLoading(false); setError(nativeEvent.description || 'Check that Flask is running and reachable from this device.'); }}
      onHttpError={({ nativeEvent }) => { if (nativeEvent.statusCode >= 500) setError(`The Plato server returned an error (${nativeEvent.statusCode}).`); }}
      javaScriptEnabled domStorageEnabled sharedCookiesEnabled thirdPartyCookiesEnabled={false}
      allowsBackForwardNavigationGestures setSupportMultipleWindows={false}
      pullToRefreshEnabled={Platform.OS === 'android'}
      style={styles.webview}
    />
    {loading && <View style={[styles.progress, { width: `${Math.max(8, progress * 100)}%` }]} />}
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f7f6f2' },
  header: { minHeight: 56, paddingHorizontal: 18, paddingVertical: 7, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e2e5df' },
  logo: { color: '#172b2a', fontSize: 20, fontWeight: '800', letterSpacing: 1.1 }, gold: { color: '#c28d47' },
  caption: { marginTop: 1, fontSize: 8, color: '#697876', letterSpacing: 1.8, fontWeight: '700' },
  reload: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#e2eee7', alignItems: 'center', justifyContent: 'center' },
  reloadIcon: { color: '#1e6554', fontSize: 26, lineHeight: 30 }, webview: { flex: 1, backgroundColor: '#f7f6f2' },
  loading: { position: 'absolute', zIndex: 2, top: 75, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 9, padding: 10 },
  loadingText: { color: '#697876', fontSize: 12 }, progress: { position: 'absolute', top: 63, left: 0, height: 2, backgroundColor: '#c28d47' },
  error: { position: 'absolute', zIndex: 3, top: '35%', left: 24, right: 24, padding: 22, borderRadius: 14, backgroundColor: '#fff', borderColor: '#e2e5df', borderWidth: 1, alignItems: 'center' },
  errorTitle: { color: '#172b2a', fontSize: 17, fontWeight: '700', textAlign: 'center' }, errorText: { color: '#697876', marginTop: 8, textAlign: 'center', lineHeight: 20 },
  button: { backgroundColor: '#1e6554', paddingHorizontal: 22, paddingVertical: 11, borderRadius: 8, marginTop: 16 }, buttonText: { color: '#fff', fontWeight: '700' },
  card: { margin: 22, marginTop: 70, padding: 24, backgroundColor: '#fff', borderRadius: 16, borderColor: '#e2e5df', borderWidth: 1 },
  title: { color: '#172b2a', fontSize: 25, fontWeight: '700', marginTop: 25 }, body: { color: '#52615e', fontSize: 15, lineHeight: 23, marginTop: 12 },
  hint: { color: '#1e6554', fontSize: 13, lineHeight: 20, marginTop: 16, padding: 12, backgroundColor: '#e2eee7', borderRadius: 9 }
});
