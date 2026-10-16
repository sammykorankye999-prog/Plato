'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

type Stage = 'loading' | 'signin' | 'enroll' | 'challenge' | 'workspace' | 'forgot-password' | 'reset-password';
type AppRole = 'inputer' | 'manager' | 'admin' | 'administrator';
type InputRow = { id: string; owner_id: string; content: string; status: string; created_at: string };

export default function Home() {
  const [stage, setStage] = useState<Stage>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<AppRole | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [factorId, setFactorId] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [qrCode, setQrCode] = useState('');
  const [record, setRecord] = useState('');
  const [inputs, setInputs] = useState<InputRow[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [authView, setAuthView] = useState<'signin' | 'create'>('signin');
  const [signupMessage, setSignupMessage] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const loadWorkspace = useCallback(async (activeSession: Session) => {
    setSession(activeSession);
    const { data: roleRow, error: roleError } = await supabase.from('user_roles')
      .select('role').eq('user_id', activeSession.user.id).maybeSingle();
    if (roleError) throw roleError;
    if (!roleRow) { setRole(null); setStage('workspace'); setMessage('Your account has no assigned application role. Contact the administrator.'); return; }
    setRole(roleRow.role);
    const { data: inputData, error: inputError } = await supabase.from('inputs')
      .select('id,owner_id,content,status,created_at').order('created_at', { ascending: false }).limit(50);
    if (inputError) throw inputError;
    setInputs(inputData ?? []);
    setStage('workspace'); setMessage('');
  }, []);

  const prepareFactor = useCallback(async (activeSession: Session) => {
    setSession(activeSession);
    const { data: aal, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalError) throw aalError;
    if (aal.currentLevel === 'aal2') { await loadWorkspace(activeSession); return; }

    const { data: factors, error: factorError } = await supabase.auth.mfa.listFactors();
    if (factorError) throw factorError;
    const verified = factors.totp.find(item => item.status === 'verified');
    if (verified) {
      const { data: challenge, error } = await supabase.auth.mfa.challenge({ factorId: verified.id });
      if (error) throw error;
      setFactorId(verified.id); setChallengeId(challenge.id); setStage('challenge');
      return;
    }

    const { data: enrollment, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator' });
    if (error) throw error;
    setFactorId(enrollment.id); setQrCode(enrollment.totp.qr_code); setStage('enroll');
  }, [loadWorkspace]);

  useEffect(() => {
    let alive = true;
    let handlingPasswordRecovery = new URLSearchParams(window.location.search).get('password_reset') === '1';
    if (handlingPasswordRecovery) {
      setStage('reset-password');
      setMessage('Choose a new password to finish resetting your account.');
    }
    const { data: listener } = supabase.auth.onAuthStateChange((event, authSession) => {
      if (!alive) return;
      if (event === 'PASSWORD_RECOVERY' && authSession) {
        handlingPasswordRecovery = true;
        setSession(authSession);
        setMessage('Choose a new password to finish resetting your account.');
        setStage('reset-password');
      }
      if (event === 'SIGNED_OUT') { setSession(null); setRole(null); setStage('signin'); }
    });
    supabase.auth.getSession().then(({ data, error }) => {
      if (!alive) return;
      if (error) { setMessage(error.message); setStage('signin'); return; }
      if (handlingPasswordRecovery) {
        if (data.session) setSession(data.session);
        else { setStage('signin'); setMessage('This reset link is invalid or expired. Request a new one.'); }
        return;
      }
      if (data.session) prepareFactor(data.session).catch(e => { setMessage(e.message); setStage('signin'); });
      else setStage('signin');
    });
    return () => { alive = false; listener.subscription.unsubscribe(); };
  }, [prepareFactor]);

  async function signIn(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
      if (data.session) await prepareFactor(data.session);
    } catch (e) { setMessage((e as Error).message); }
    finally { setBusy(false); }
  }

  async function signUp(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage(''); setSignupMessage('');
    try {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) throw error;
      if (data.session) {
        setSignupMessage('Account created. Set up your authenticator to finish securing your account.');
        await prepareFactor(data.session);
      } else {
        setSignupMessage('Check your email for the confirmation link. After confirming, sign in to set up your authenticator.');
      }
    } catch (e) { setMessage((e as Error).message); }
    finally { setBusy(false); }
  }

  async function googleSignIn() {
    setBusy(true); setMessage('');
    const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } });
    if (error) { setMessage(error.message); setBusy(false); }
  }

  async function requestPasswordReset(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage(''); setSignupMessage('');
    try {
      const redirectUrl = new URL(window.location.origin);
      redirectUrl.searchParams.set('password_reset', '1');
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: redirectUrl.toString() });
      if (error) throw error;
      setSignupMessage('If an account exists for that email, a password reset link has been sent.');
    } catch (e) { setMessage((e as Error).message); }
    finally { setBusy(false); }
  }

  async function finishPasswordReset(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    if (newPassword !== confirmPassword) { setMessage('The new passwords do not match.'); setBusy(false); return; }
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      window.history.replaceState({}, document.title, window.location.pathname);
      await supabase.auth.signOut();
      setNewPassword(''); setConfirmPassword(''); setPassword('');
      setStage('signin'); setMessage('Password changed. Sign in with your new password, then complete MFA.');
    } catch (e) { setMessage((e as Error).message); }
    finally { setBusy(false); }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    if (newPassword !== confirmPassword) { setMessage('The new passwords do not match.'); setBusy(false); return; }
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword, current_password: currentPassword });
      if (error) throw error;
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
      setMessage('Password changed successfully.');
    } catch (e) { setMessage((e as Error).message); }
    finally { setBusy(false); }
  }

  async function verifyFactor(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      let activeChallenge = challengeId;
      if (!activeChallenge) {
        const { data, error } = await supabase.auth.mfa.challenge({ factorId });
        if (error) throw error;
        activeChallenge = data.id;
      }
      const { error } = await supabase.auth.mfa.verify({ factorId, challengeId: activeChallenge, code: code.trim() });
      if (error) throw error;
      setCode(''); setQrCode(''); setChallengeId('');
      const { data: verifiedSession, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw sessionError;
      if (verifiedSession.session) await loadWorkspace(verifiedSession.session);
    } catch (e) { setMessage((e as Error).message); }
    finally { setBusy(false); }
  }

  async function createInput(event: FormEvent) {
    event.preventDefault(); if (!session) return; setBusy(true); setMessage('');
    const { error } = await supabase.from('inputs').insert({ owner_id: session.user.id, content: record.trim() });
    if (error) setMessage(error.message);
    else { setRecord(''); await loadWorkspace(session); }
    setBusy(false);
  }

  async function manageUser(action: 'add_inputer' | 'deactivate_inputer' | 'assign_role', values: Record<string, string>) {
    setBusy(true); setMessage('');
    const { error } = await supabase.functions.invoke('manage-users', { body: { action, ...values } });
    if (error) setMessage(error.message);
    else if (session) {
      if (action === 'deactivate_inputer') setMessage('Inputer deactivated.');
      else setMessage('Role updated.');
      await loadWorkspace(session);
    } else if (!error) setMessage('Invitation sent.');
    setBusy(false);
  }

  if (stage === 'loading') return <main className="shell"><p>Checking your sign-in…</p></main>;
  return <main className="shell">
    <header><span className="mark">LL</span><span>SECURE WORKSPACE<small>ROLE-BASED ACCESS</small></span></header>
    {message && <div className="notice" role="status">{message}</div>}
    {stage === 'forgot-password' && <section className="hero"><p className="eyebrow">ACCOUNT RECOVERY</p><h1>Reset your password.</h1><p className="muted">Enter your account email and we’ll send a secure reset link if an account exists.</p><form className="card" onSubmit={requestPasswordReset}><label>Email address<input type="email" autoComplete="email" required value={email} onChange={e=>setEmail(e.target.value)}/></label>{signupMessage && <div className="signup-notice" role="status">{signupMessage}</div>}<button disabled={busy}>{busy?'Sending link…':'Send reset link'}</button><button type="button" className="secondary back-button" onClick={()=>{setMessage('');setStage('signin')}}>Back to sign in</button></form></section>}
    {stage === 'reset-password' && <section className="hero"><p className="eyebrow">ACCOUNT RECOVERY</p><h1>Choose a new password.</h1><p className="muted">Use at least 12 characters. After saving, sign in again and complete MFA.</p><form className="card" onSubmit={finishPasswordReset}><label>New password<input type="password" autoComplete="new-password" minLength={12} required value={newPassword} onChange={e=>setNewPassword(e.target.value)}/></label><label>Confirm new password<input type="password" autoComplete="new-password" minLength={12} required value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)}/></label><button disabled={busy}>{busy?'Updating password…':'Update password'}</button></form></section>}
    {stage === 'signin' && <section className="login-layout"><aside className="login-story"><p className="eyebrow">SECURE WORKSPACE · PRIVATE ACCESS</p><h1>Good work<br/>starts with trust.</h1><p>One secure place for your team’s records, with the right access for every role.</p><div className="story-rule"><span>01</span><div><b>Verified identity</b><small>Secure sign-in with your organization account</small></div></div><div className="story-rule"><span>02</span><div><b>Protected at every step</b><small>Authenticator verification before workspace access</small></div></div><div className="story-decoration" aria-hidden="true"><i/><i/><i/></div></aside><div className="login-panel"><div className="auth-tabs" role="tablist" aria-label="Account access"><button type="button" role="tab" aria-selected={authView==='signin'} className={authView==='signin'?'active':''} onClick={()=>{setAuthView('signin');setMessage('');setSignupMessage('')}}>Sign in</button><button type="button" role="tab" aria-selected={authView==='create'} className={authView==='create'?'active':''} onClick={()=>{setAuthView('create');setMessage('');setSignupMessage('')}}>Create account</button></div>{authView==='signin'?<><p className="eyebrow">WELCOME BACK</p><h2>Sign in to continue</h2><p className="muted">Use your email and password, or continue with Google.</p>
      <form className="card" onSubmit={signIn}><label>Email<input type="email" autoComplete="username" required value={email} onChange={e=>setEmail(e.target.value)}/></label><label>Password<input type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)}/></label><button disabled={busy}>Continue with password <span>→</span></button><div className="divider">or</div><button type="button" className="secondary" disabled={busy} onClick={googleSignIn}>Continue with Google</button></form>
      <button type="button" className="text-button" onClick={()=>{setMessage('');setSignupMessage('');setStage('forgot-password')}}>Forgot password?</button><p className="panel-foot">Access is monitored and protected by multi-factor authentication.</p></>:<><p className="eyebrow">CREATE YOUR ACCOUNT</p><h2>Get started securely</h2><p className="muted">Create an account with your email. Confirm it, then set up an authenticator.</p>{signupMessage && <div className="signup-notice" role="status">{signupMessage}</div>}<form className="login-form" onSubmit={signUp}><label>Email address<input type="email" placeholder="name@example.com" autoComplete="email" required value={email} onChange={e=>setEmail(e.target.value)}/></label><label>Create password<input type="password" placeholder="At least 12 characters" autoComplete="new-password" minLength={12} required value={password} onChange={e=>setPassword(e.target.value)}/></label><button disabled={busy}>{busy?'Creating account…':'Create account securely'} <span>→</span></button></form><p className="panel-foot">New accounts start with basic input access. An administrator can grant additional roles.</p></>}</div></section>}
    {stage === 'enroll' && <section className="hero"><p className="eyebrow">TWO-FACTOR SETUP</p><h1>Connect your authenticator.</h1><p className="muted">Scan this QR code with an authenticator app, then enter its current six-digit code.</p><div className="card enroll"><img alt="Authenticator enrollment QR code" src={qrCode}/><form onSubmit={verifyFactor}><label>Authenticator code<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={e=>setCode(e.target.value)}/></label><button disabled={busy}>Verify and continue</button></form></div></section>}
    {stage === 'challenge' && <section className="hero"><p className="eyebrow">TWO-FACTOR CHECK</p><h1>Enter your code.</h1><p className="muted">Open your authenticator app and enter the current six-digit code.</p><form className="card" onSubmit={verifyFactor}><label>Authenticator code<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={e=>setCode(e.target.value)}/></label><button disabled={busy}>Verify <span>→</span></button></form></section>}
    {stage === 'workspace' && <>
      <section className="card password-card"><h2>Change password</h2><p className="muted">Confirm your current password and choose a new one.</p><form onSubmit={changePassword}><label>Current password<input type="password" autoComplete="current-password" required value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)}/></label><label>New password<input type="password" autoComplete="new-password" minLength={12} required value={newPassword} onChange={e=>setNewPassword(e.target.value)}/></label><label>Confirm new password<input type="password" autoComplete="new-password" minLength={12} required value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)}/></label><button disabled={busy}>{busy?'Updating password…':'Change password'}</button></form></section>
      <section className="hero"><p className="eyebrow">SIGNED IN · {role?.toUpperCase() ?? 'ROLE PENDING'}</p><h1>Welcome.</h1><p className="muted">{session?.user.email} · Access requires password or Google plus verified TOTP.</p><button className="secondary" onClick={()=>supabase.auth.signOut()}>Sign out</button></section>
      {role && <section className="card"><h2>New input</h2><form onSubmit={createInput}><label>Record details<textarea maxLength={4000} rows={3} required value={record} onChange={e=>setRecord(e.target.value)}/></label><button disabled={busy}>Save draft</button></form></section>}
      <section className="card"><h2>Recent records</h2>{inputs.length ? inputs.map(row=><article className="record" key={row.id}><p>{row.content}</p><small>{row.status} · {new Date(row.created_at).toLocaleString()}</small></article>) : <p className="muted">No records available.</p>}</section>
      {role && ['manager','admin','administrator'].includes(role) && <UserManagement role={role} ownUserId={session?.user.id ?? ''} busy={busy} onAdd={email=>manageUser('add_inputer',{email})} onDeactivate={userId=>manageUser('deactivate_inputer',{userId})} onAssign={(userId,newRole)=>manageUser('assign_role',{userId,role:newRole})}/>}
    </>}
    <footer>Protected by Supabase Auth, MFA, and database row policies.</footer>
  </main>;
}

function UserManagement({ role, ownUserId, busy, onAdd }: { role: AppRole; ownUserId:string; busy: boolean; onAdd: (email:string)=>void; onDeactivate:(id:string)=>void; onAssign:(id:string,role:AppRole)=>void }) {
  const [email, setEmail] = useState('');
  return <section className="card"><h2>User accounts</h2>{['manager','administrator'].includes(role) && <form onSubmit={e=>{e.preventDefault(); onAdd(email); setEmail('')}}><label>Invite inputer by email<input type="email" required value={email} onChange={e=>setEmail(e.target.value)}/></label><button disabled={busy}>Send invitation</button></form>}<p className="muted">For role changes and account deactivation, use a protected administrator workflow. The account directory is intentionally not exposed to this client.</p></section>;
}
