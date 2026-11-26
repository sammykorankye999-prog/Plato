import { useState } from 'react';
import { ActivityIndicator, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

const API_URL = (process.env.EXPO_PUBLIC_PLATO_API_URL || '').trim().replace(/\/$/, '');

export default function ResetPasswordPage() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = Array.isArray(params.token) ? params.token[0] : params.token || '';
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);

  async function submit() {
    setMessage('');
    if (password.length < 12) {
      setMessage('Use a password with at least 12 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setMessage('The passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${API_URL}/api/v1/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'This reset link is invalid or expired.');
      setComplete(true);
      setMessage('Password updated. Sign in with your new password and authenticator code.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Password could not be updated.');
    } finally {
      setBusy(false);
    }
  }

  return <SafeAreaView style={styles.page}><View style={styles.panel}>
    <Text style={styles.brand}>PLATO<Text style={styles.gold}>.</Text></Text>
    <Text style={styles.kicker}>ACCOUNT RECOVERY</Text>
    <Text style={styles.heading}>Choose a new password</Text>
    {!API_URL ? <Text style={styles.body}>The service address is not configured. Please contact the administrator.</Text> : !token ? <Text style={styles.body}>This reset link is missing its token. Request a new link from the sign-in page.</Text> : <>
      <Text style={styles.body}>Choose a new password with at least 12 characters. Your authenticator setup stays enabled.</Text>
      {!complete && <>
        <TextInput style={styles.input} placeholder="New password" secureTextEntry autoComplete="new-password" value={password} onChangeText={setPassword} />
        <TextInput style={styles.input} placeholder="Confirm new password" secureTextEntry autoComplete="new-password" value={confirmPassword} onChangeText={setConfirmPassword} />
        <Pressable style={[styles.button, busy && styles.disabled]} onPress={submit} disabled={busy}>
          <Text style={styles.buttonText}>{busy ? 'Updating…' : 'Update password'}</Text>
        </Pressable>
      </>}
      {busy && <ActivityIndicator color="#1e6554" style={styles.spinner} />}
      {!!message && <Text accessibilityRole="alert" style={complete ? styles.success : styles.message}>{message}</Text>}
    </>}
    <Pressable onPress={() => router.replace('/')}><Text style={styles.link}>Back to sign in</Text></Pressable>
  </View></SafeAreaView>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f7f6f2', justifyContent: 'center', padding: 20 },
  panel: { width: '100%', maxWidth: 560, alignSelf: 'center', backgroundColor: '#fff', borderWidth: 1, borderColor: '#dce5df', borderRadius: 18, padding: 28, gap: 14 },
  brand: { color: '#102b2b', fontSize: 25, fontWeight: '900', letterSpacing: 2 },
  gold: { color: '#bf8b42' },
  kicker: { color: '#bf8b42', fontSize: 12, fontWeight: '800', letterSpacing: 2 },
  heading: { color: '#102b2b', fontSize: 28, fontWeight: '900' },
  body: { color: '#52615d', fontSize: 15, lineHeight: 23 },
  input: { minHeight: 54, borderWidth: 1, borderColor: '#dce5df', borderRadius: 12, paddingHorizontal: 14, fontSize: 16, color: '#142d2a' },
  button: { minHeight: 52, backgroundColor: '#8cb4a9', borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  link: { color: '#176757', fontSize: 15, fontWeight: '700', marginTop: 5 },
  spinner: { marginVertical: 8 },
  message: { color: '#9b3f24', backgroundColor: '#fff1e2', padding: 12, borderRadius: 10 },
  success: { color: '#176757', backgroundColor: '#e8f4ef', padding: 12, borderRadius: 10 },
});
