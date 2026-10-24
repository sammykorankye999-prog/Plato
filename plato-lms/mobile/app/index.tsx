import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View, Switch } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const API_URL = (process.env.EXPO_PUBLIC_PLATO_API_URL || '').trim().replace(/\/$/, '');
type User = { id: number; username: string; email: string; role: 'student' | 'instructor' | 'admin' };
type Course = { id: number; title: string; description: string; instructor?: string; enrolled?: boolean; is_owner?: boolean; lessons?: { id: number; title: string; content: string; completed?: boolean }[]; lesson_count?: number };
type ApiResult = Record<string, any>;

async function api(path: string, token?: string, method = 'GET', body?: object): Promise<ApiResult> {
  const response = await fetch(`${API_URL}/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

export default function PlatoMobile() {
  const [token, setToken] = useState('');
  const [user, setUser] = useState<User | null>(null);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [registerMode, setRegisterMode] = useState(false);
  const [accountRole, setAccountRole] = useState<'student' | 'instructor'>('student');
  const [inviteCode, setInviteCode] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState('');
  const [qr, setQr] = useState('');
  const [courses, setCourses] = useState<Course[]>([]);
  const [available, setAvailable] = useState<Course[]>([]);
  const [selected, setSelected] = useState<Course | null>(null);
  const [admin, setAdmin] = useState<ApiResult | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [lessonTitle, setLessonTitle] = useState('');
  const [lessonContent, setLessonContent] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'student' | 'instructor' | 'admin'>('student');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (access = token) => {
    const [me, list] = await Promise.all([api('/me', access), api('/courses', access)]);
    setUser(me.user);
    setCourses(list.courses || []);
    setAvailable(list.available_courses || []);
    if (me.user.role === 'admin') setAdmin(await api('/admin/summary', access));
  }, [token]);

  useEffect(() => {
    if (API_URL) api('/health').catch(error => setMessage(`Backend unavailable: ${error.message}`));
  }, []);

  async function signIn() {
    setBusy(true); setMessage('');
    try {
      const result = await api('/auth/login', undefined, 'POST', { username, password });
      setChallenge(result.challenge_token);
      if (result.mfa_setup_required) {
        setQr(result.qr_data);
        setMessage('Scan this QR code with your authenticator app, then enter its current code.');
      } else setMessage('Enter the current six-digit authenticator code.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Sign-in failed'); }
    finally { setBusy(false); }
  }

  async function register() {
    setBusy(true); setMessage('');
    try {
      const result = await api('/auth/register', undefined, 'POST', {
        username, email, password, role: accountRole,
        ...(accountRole === 'instructor' ? { invite_code: inviteCode } : {}),
      });
      setRegisterMode(false); setPassword(''); setMessage(result.message || 'Account created. Sign in to continue.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Registration failed'); }
    finally { setBusy(false); }
  }

  async function verifyCode() {
    setBusy(true); setMessage('');
    try {
      const result = await api('/auth/verify-totp', challenge, 'POST', { code });
      setToken(result.access_token); setUser(result.user); setChallenge(''); setQr(''); setCode('');
      await refresh(result.access_token);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Code verification failed'); }
    finally { setBusy(false); }
  }

  async function signOut() {
    try { if (token) await api('/auth/logout', token, 'POST', {}); } catch { /* clear local session even if offline */ }
    setToken(''); setUser(null); setCourses([]); setAvailable([]); setSelected(null); setAdmin(null); setChallenge(''); setQr(''); setPassword(''); setMessage('Signed out.');
  }

  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage('');
    try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : 'Request failed'); }
    finally { setBusy(false); }
  }

  if (!API_URL) return <SafeAreaView style={styles.page}><View style={styles.panel}>
    <Text style={styles.brand}>PLATO<Text style={styles.gold}>.</Text></Text><Text style={styles.heading}>Backend address required</Text>
    <Text style={styles.body}>Set EXPO_PUBLIC_PLATO_API_URL in mobile/.env to your AWS HTTPS backend URL, then restart Expo.</Text>
  </View></SafeAreaView>;

  if (!token || !user) return <SafeAreaView style={styles.page}><ScrollView contentContainerStyle={styles.container}>
    <View style={styles.panel}>
      <Text style={styles.brand}>PLATO<Text style={styles.gold}>.</Text></Text>
      <Text style={styles.eyebrow}>YOUR LEARNING SPACE</Text>
      <Text style={styles.heading}>{challenge ? (qr ? 'Set up two-factor' : 'Verify your identity') : registerMode ? 'Create your account' : 'Welcome back'}</Text>
      {challenge ? <>
        {qr ? <><Text style={styles.body}>Scan this QR code with an authenticator app such as Google Authenticator or Microsoft Authenticator.</Text><Image source={{ uri: qr }} style={styles.qr} /></> : null}
        <TextInput style={styles.input} placeholder="Six-digit authenticator code" keyboardType="number-pad" value={code} onChangeText={setCode} maxLength={8} />
        <Action label="Verify code" onPress={verifyCode} disabled={busy || code.length < 6} />
      </> : <>
        <TextInput style={styles.input} placeholder="Username or email" autoCapitalize="none" value={username} onChangeText={setUsername} />
        {registerMode && <>
          <TextInput style={styles.input} placeholder="Email address" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
          <Pressable onPress={() => setAccountRole(accountRole === 'student' ? 'instructor' : 'student')}><Text style={styles.link}>Account type: {accountRole} (tap to change)</Text></Pressable>
          {accountRole === 'instructor' && <TextInput style={styles.input} placeholder="Instructor invite code" autoCapitalize="none" value={inviteCode} onChangeText={setInviteCode} />}
        </>}
        <TextInput style={styles.input} placeholder="Password" secureTextEntry value={password} onChangeText={setPassword} />
        <Action label={registerMode ? 'Create account' : 'Sign in'} onPress={registerMode ? register : signIn} disabled={busy || !username || password.length < (registerMode ? 12 : 1) || (registerMode && !email)} />
        <Pressable onPress={() => { setRegisterMode(!registerMode); setMessage(''); }}><Text style={styles.link}>{registerMode ? 'Already registered? Sign in' : 'New here? Create an account'}</Text></Pressable>
      </>}
      {busy ? <ActivityIndicator color="#1e6554" style={styles.spinner} /> : null}
      {!!message && <Text accessibilityRole="alert" style={styles.message}>{message}</Text>}
      {challenge ? <Pressable onPress={() => { setChallenge(''); setQr(''); setMessage(''); }}><Text style={styles.link}>Back to sign in</Text></Pressable> : null}
    </View>
  </ScrollView></SafeAreaView>;

  if (selected) return <SafeAreaView style={styles.page}><ScrollView contentContainerStyle={styles.container}>
    <Pressable onPress={() => setSelected(null)}><Text style={styles.link}>‹ All courses</Text></Pressable>
    <View style={styles.panel}><Text style={styles.eyebrow}>{selected.instructor || 'PLATO COURSE'}</Text><Text style={styles.heading}>{selected.title}</Text><Text style={styles.body}>{selected.description}</Text>
      {selected.lessons ? selected.lessons.map((lesson, i) => <View key={lesson.id} style={styles.lesson}>
        <Text style={styles.eyebrow}>LESSON {i + 1}{lesson.completed ? ' · COMPLETE' : ''}</Text><Text style={styles.subheading}>{lesson.title}</Text><Text style={styles.body}>{lesson.content}</Text>
        {user.role === 'student' && <Action label={lesson.completed ? 'Mark incomplete' : 'Mark complete'} secondary onPress={() => run(async () => {
          await api(`/lessons/${lesson.id}/complete`, token, 'POST', { completed: !lesson.completed });
          const result = await api(`/courses/${selected.id}`, token); setSelected(result.course); await refresh();
        })} />}
      </View>) : <Text style={styles.body}>Enroll to access lessons.</Text>}
      {selected.is_owner && <View style={styles.lesson}><Text style={styles.subheading}>Add a lesson</Text>
        <TextInput style={styles.input} placeholder="Lesson title" value={lessonTitle} onChangeText={setLessonTitle} />
        <TextInput style={[styles.input, styles.multiline]} placeholder="Detailed lesson teaching" value={lessonContent} onChangeText={setLessonContent} multiline />
        <Action label="Add lesson" onPress={() => run(async () => { await api(`/courses/${selected.id}/lessons`, token, 'POST', { title: lessonTitle, content: lessonContent }); setLessonTitle(''); setLessonContent(''); const result = await api(`/courses/${selected.id}`, token); setSelected(result.course); await refresh(); })} disabled={!lessonTitle.trim()} />
      </View>}
    </View>
  </ScrollView></SafeAreaView>;

  return <SafeAreaView style={styles.page}><ScrollView contentContainerStyle={styles.container}>
    <View style={styles.topbar}><View><Text style={styles.brand}>PLATO<Text style={styles.gold}>.</Text></Text><Text style={styles.caption}>LEARNING, AT YOUR PACE</Text></View><Pressable onPress={signOut}><Text style={styles.link}>Sign out</Text></Pressable></View>
    <View style={styles.panel}><Text style={styles.eyebrow}>{user.role.toUpperCase()} DASHBOARD</Text><Text style={styles.heading}>Hello, {user.username}</Text><Text style={styles.body}>{user.email}</Text></View>
    {user.role === 'instructor' && <View style={styles.panel}><Text style={styles.subheading}>Create a course</Text><TextInput style={styles.input} placeholder="Course title" value={title} onChangeText={setTitle} /><TextInput style={[styles.input, styles.multiline]} placeholder="Course description" value={description} onChangeText={setDescription} multiline />
      <Action label="Create course" onPress={() => run(async () => { await api('/courses', token, 'POST', { title, description }); setTitle(''); setDescription(''); await refresh(); })} disabled={!title.trim()} />
    </View>}
    <Text style={styles.section}>My courses</Text>
    {courses.length ? courses.map(course => <CourseCard key={course.id} course={course} onPress={() => run(async () => { const result = await api(`/courses/${course.id}`, token); setSelected(result.course); })} />) : <Text style={styles.body}>No courses here yet.</Text>}
    {!!available.length && <><Text style={styles.section}>Explore courses</Text>{available.map(course => <CourseCard key={course.id} course={course} action="Enroll" onPress={() => run(async () => { await api(`/courses/${course.id}/enroll`, token, 'POST', {}); await refresh(); })} />)}</>}
    {user.role === 'admin' && admin && <View style={styles.panel}><Text style={styles.section}>Administration</Text><Text style={styles.body}>Students {admin.counts.students} · Instructors {admin.counts.instructors} · Admins {admin.counts.admins} · Courses {admin.counts.courses}</Text>
      {(admin.users || []).map((person: ApiResult) => <View key={person.id} style={styles.userRow}><View style={{ flex: 1 }}><Text style={styles.subheading}>{person.username}</Text><Text style={styles.caption}>{person.email} · {person.role}{person.is_deleted ? ' · inactive' : ''}</Text></View>
        <Pressable onPress={() => run(async () => { const roles = ['student', 'instructor', 'admin']; const next = roles[(roles.indexOf(person.role) + 1) % roles.length]; await api(`/admin/users/${person.id}`, token, 'PATCH', { role: next }); await refresh(); })}><Text style={styles.link}>Role ↻</Text></Pressable>
        {!person.is_deleted && <Pressable onPress={() => run(async () => { await api(`/admin/users/${person.id}/reset-mfa`, token, 'POST', {}); await refresh(); setMessage(`MFA reset for ${person.username}.`); })}><Text style={styles.link}>Reset MFA</Text></Pressable>}
        <Pressable onPress={() => run(async () => { await api(`/admin/users/${person.id}`, token, 'PATCH', { is_deleted: !person.is_deleted }); await refresh(); })}><Text style={styles.link}>{person.is_deleted ? 'Restore' : 'Deactivate'}</Text></Pressable></View>)}
      <Text style={styles.subheading}>Add a user</Text>
      <TextInput style={styles.input} placeholder="Username" autoCapitalize="none" value={newUsername} onChangeText={setNewUsername} />
      <TextInput style={styles.input} placeholder="Email" autoCapitalize="none" keyboardType="email-address" value={newEmail} onChangeText={setNewEmail} />
      <TextInput style={styles.input} placeholder="Temporary password (12+ characters)" secureTextEntry value={newPassword} onChangeText={setNewPassword} />
      <Pressable onPress={() => setNewRole(newRole === 'student' ? 'instructor' : newRole === 'instructor' ? 'admin' : 'student')}><Text style={styles.link}>Role: {newRole} (tap to change)</Text></Pressable>
      <Action label="Add user" onPress={() => run(async () => { await api('/admin/users', token, 'POST', { username: newUsername, email: newEmail, password: newPassword, role: newRole }); setNewUsername(''); setNewEmail(''); setNewPassword(''); await refresh(); setMessage('User created. They must enroll in MFA at first sign-in.'); })} disabled={!newUsername || !newEmail || newPassword.length < 12} />
      <Text style={styles.subheading}>Access settings</Text>
      {Object.entries(admin.settings || {}).map(([key, value]) => <View key={key} style={styles.userRow}><Text style={styles.body}>{key.replaceAll('_', ' ')}</Text><Switch value={Boolean(value)} onValueChange={enabled => run(async () => { await api('/admin/settings', token, 'PATCH', { [key]: enabled }); await refresh(); })} /></View>)}
      <Action label="Save configuration backup" secondary onPress={() => run(async () => { await api('/admin/config-backups', token, 'POST', {}); setMessage('Configuration backup saved.'); })} />
      <Action label="Restore latest configuration" secondary onPress={() => run(async () => { const result = await api('/admin/config-backups/restore-latest', token, 'POST', {}); setMessage(result.message); await refresh(); })} />
    </View>}
    {busy ? <ActivityIndicator color="#1e6554" style={styles.spinner} /> : null}
    {!!message && <Text accessibilityRole="alert" style={styles.message}>{message}</Text>}
  </ScrollView></SafeAreaView>;
}

function Action({ label, onPress, disabled = false, secondary = false }: { label: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={[styles.button, secondary && styles.secondaryButton, disabled && styles.disabled]}><Text style={[styles.buttonText, secondary && styles.secondaryText]}>{label}</Text></Pressable>;
}

function CourseCard({ course, onPress, action }: { course: Course; onPress: () => void; action?: string }) {
  return <View style={styles.courseCard}><Pressable style={{ flex: 1 }} onPress={onPress}><Text style={styles.subheading}>{course.title}</Text><Text numberOfLines={3} style={styles.body}>{course.description}</Text><Text style={styles.caption}>{course.instructor || 'Your course'}{course.lesson_count !== undefined ? ` · ${course.lesson_count} lessons` : ''}</Text></Pressable>{action ? <Action label={action} onPress={onPress} /> : null}</View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f4f5f2' }, container: { width: '100%', maxWidth: 760, alignSelf: 'center', padding: 20, paddingBottom: 50 },
  panel: { backgroundColor: '#fff', borderColor: '#e0e6df', borderWidth: 1, borderRadius: 18, padding: 22, marginBottom: 16 },
  topbar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, marginBottom: 12 },
  brand: { color: '#172b2a', fontSize: 23, fontWeight: '900', letterSpacing: 1.2 }, gold: { color: '#c28d47' }, caption: { color: '#71807c', fontSize: 11, marginTop: 4 },
  eyebrow: { color: '#b07b37', fontSize: 11, letterSpacing: 1.5, fontWeight: '800', marginBottom: 8 }, heading: { color: '#172b2a', fontSize: 28, fontWeight: '800', marginBottom: 8 }, subheading: { color: '#172b2a', fontSize: 17, fontWeight: '700', marginBottom: 5 },
  body: { color: '#52615e', fontSize: 14, lineHeight: 21, marginBottom: 10 }, input: { borderColor: '#dce3dc', borderWidth: 1, borderRadius: 10, backgroundColor: '#fbfcfa', padding: 13, fontSize: 15, color: '#172b2a', marginTop: 10 }, multiline: { minHeight: 90, textAlignVertical: 'top' },
  button: { backgroundColor: '#1e6554', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center', marginTop: 10 }, buttonText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  secondaryButton: { backgroundColor: '#e8f0eb' }, secondaryText: { color: '#1e6554' }, disabled: { opacity: 0.5 }, spinner: { margin: 16 }, message: { color: '#8b5632', backgroundColor: '#fff4e7', padding: 12, borderRadius: 9, marginVertical: 10 }, link: { color: '#1e6554', fontWeight: '700', paddingVertical: 8 }, qr: { width: 210, height: 210, alignSelf: 'center', margin: 14 },
  section: { color: '#172b2a', fontSize: 19, fontWeight: '800', marginTop: 16, marginBottom: 10 }, courseCard: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#e0e6df', borderRadius: 14, padding: 16, marginBottom: 10 }, lesson: { borderTopWidth: 1, borderTopColor: '#e8ece7', marginTop: 14, paddingTop: 14 }, userRow: { borderTopWidth: 1, borderTopColor: '#e8ece7', paddingVertical: 10, flexDirection: 'row', alignItems: 'center' },
});
