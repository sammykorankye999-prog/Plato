'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

type Stage = 'loading' | 'signin' | 'enroll' | 'challenge' | 'workspace' | 'forgot-password' | 'reset-password';
type AppRole = 'inputer' | 'manager' | 'admin' | 'administrator';
type InputRow = { id: string; owner_id: string; content: string; status: string; created_at: string };
type UserRoleRow = { user_id: string; email: string; role: AppRole; active: boolean; created_at: string };
type AuditRow = { id: number; event: string; actor_id: string | null; target_user_id: string | null; created_at: string; details: Record<string, string> };
type ConfigRow = { maintenance_mode: boolean; offline_entry_enabled: boolean; max_record_length: number; updated_at: string };
type ConfigVersion = { id: number; maintenance_mode: boolean; offline_entry_enabled: boolean; max_record_length: number; reason: string; created_at: string; changed_by: string | null };
type BackupRun = { id: number; provider: string; backup_kind: string; status: string; artifact_key: string | null; checksum_sha256: string | null; started_at: string; completed_at: string | null };

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
  const [hasMoreInputs, setHasMoreInputs] = useState(false);
  const [directory, setDirectory] = useState<UserRoleRow[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditRow[]>([]);
  const [backupRuns, setBackupRuns] = useState<BackupRun[]>([]);
  const [configurationAvailable, setConfigurationAvailable] = useState(false);
  const [workspaceConfig, setWorkspaceConfig] = useState<ConfigRow>({ maintenance_mode: false, offline_entry_enabled: true, max_record_length: 4000, updated_at: '' });
  const [configVersions, setConfigVersions] = useState<ConfigVersion[]>([]);
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
    const { data: configData, error: configError } = await supabase.from('workspace_configuration')
      .select('maintenance_mode,offline_entry_enabled,max_record_length,updated_at').eq('singleton', true).single();
    if (configError?.code === 'PGRST205') {
      setConfigurationAvailable(false);
      setWorkspaceConfig({ maintenance_mode: false, offline_entry_enabled: true, max_record_length: 4000, updated_at: '' });
    } else if (configError) throw configError;
    else { setConfigurationAvailable(true); setWorkspaceConfig(configData); }
    const { data: inputData, error: inputError } = await supabase.from('inputs')
      .select('id,owner_id,content,status,created_at').order('created_at', { ascending: false }).order('id', { ascending: false }).range(0, 49);
    if (inputError) throw inputError;
    setInputs(inputData ?? []);
    setHasMoreInputs((inputData?.length ?? 0) === 50);
    if (['manager', 'admin', 'administrator'].includes(roleRow.role)) {
      const { data, error } = await supabase.from('user_roles')
        .select('user_id,email,role,active,created_at').order('created_at', { ascending: false });
      if (error) throw error;
      setDirectory(data ?? []);
    } else setDirectory([]);
    if (['admin', 'administrator'].includes(roleRow.role)) {
      const { data, error } = await supabase.from('audit_events')
        .select('id,event,actor_id,target_user_id,created_at,details').order('created_at', { ascending: false }).order('id', { ascending: false });
      if (error) throw error;
      setAuditEvents(data ?? []);
      const { data: backups, error: backupError } = await supabase.from('backup_runs')
        .select('id,provider,backup_kind,status,artifact_key,checksum_sha256,started_at,completed_at').order('started_at', { ascending: false });
      if (backupError?.code === 'PGRST205') setBackupRuns([]);
      else if (backupError) throw backupError;
      else setBackupRuns(backups ?? []);
      const { data: versions, error: versionsError } = await supabase.from('workspace_configuration_versions')
        .select('id,maintenance_mode,offline_entry_enabled,max_record_length,reason,created_at,changed_by').order('id', { ascending: false });
      if (versionsError?.code === 'PGRST205') setConfigVersions([]);
      else if (versionsError) throw versionsError;
      else setConfigVersions(versions ?? []);
    } else { setAuditEvents([]); setBackupRuns([]); setConfigVersions([]); }
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
    if (workspaceConfig.maintenance_mode && role !== 'admin' && role !== 'administrator') { setMessage('Record entry is paused for maintenance.'); setBusy(false); return; }
    if (record.trim().length > workspaceConfig.max_record_length) { setMessage(`Keep the record under ${workspaceConfig.max_record_length} characters.`); setBusy(false); return; }
    const { error } = await supabase.from('inputs').insert({ owner_id: session.user.id, content: record.trim() });
    if (error) setMessage(error.message);
    else { setRecord(''); await loadWorkspace(session); }
    setBusy(false);
  }

  async function loadOlderInputs() {
    if (!session || busy || !hasMoreInputs) return;
    setBusy(true);
    const from = inputs.length;
    const { data, error } = await supabase.from('inputs').select('id,owner_id,content,status,created_at')
      .order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, from + 49);
    if (error) setMessage(error.message);
    else { setInputs(current => [...current, ...(data ?? [])]); setHasMoreInputs((data?.length ?? 0) === 50); }
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

  async function saveWorkspaceConfiguration(values: Pick<ConfigRow, 'maintenance_mode'|'offline_entry_enabled'|'max_record_length'>, reason: string) {
    setBusy(true); setMessage('');
    const { error } = await supabase.rpc('change_workspace_configuration', {
      p_maintenance_mode: values.maintenance_mode,
      p_offline_entry_enabled: values.offline_entry_enabled,
      p_max_record_length: values.max_record_length,
      p_reason: reason,
    });
    if (error) setMessage(error.message);
    else if (session) { setMessage('Workspace configuration saved as a new version.'); await loadWorkspace(session); }
    setBusy(false);
  }

  async function restoreWorkspaceConfiguration(versionId: number, reason: string) {
    setBusy(true); setMessage('');
    const { error } = await supabase.rpc('restore_workspace_configuration', { p_version_id: versionId, p_reason: reason });
    if (error) setMessage(error.message);
    else if (session) { setMessage('Configuration restored. User records were left unchanged.'); await loadWorkspace(session); }
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
    {stage === 'challenge' && <section className="hero"><p className="eyebrow">TWO-FACTOR CHECK</p><h1>Enter your code.</h1><p className="muted">Open your authenticator app and enter the current six-digit code.</p><form className="card" onSubmit={verifyFactor}><label>Authenticator code<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={e=>setCode(e.target.value)}/></label><button disabled={busy}>Verify <span>→</span></button><p className="panel-foot">Lost your authenticator? A project owner must reset its TOTP factor. Then sign in again to enroll a new QR code.</p><a href="https://github.com/sammykorankye999-prog/Secure-Workspace/blob/main/README.md#recover-a-lost-authenticator">Authenticator recovery steps</a></form></section>}
    {stage === 'workspace' && <>
      <section className="card password-card"><h2>Change password</h2><p className="muted">Confirm your current password and choose a new one.</p><form onSubmit={changePassword}><label>Current password<input type="password" autoComplete="current-password" required value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)}/></label><label>New password<input type="password" autoComplete="new-password" minLength={12} required value={newPassword} onChange={e=>setNewPassword(e.target.value)}/></label><label>Confirm new password<input type="password" autoComplete="new-password" minLength={12} required value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)}/></label><button disabled={busy}>{busy?'Updating password…':'Change password'}</button></form></section>
      <section className="hero"><p className="eyebrow">{dashboardTitle(role)}</p><h1>{dashboardHeading(role)}.</h1><p className="muted">{session?.user.email} · Access requires password or Google plus verified TOTP.</p><button className="secondary" onClick={()=>supabase.auth.signOut()}>Sign out</button></section>
      {role && role !== 'inputer' && <section className="stats-grid"><article className="stat-card"><span>Visible records</span><strong>{inputs.length}</strong></article><article className="stat-card"><span>Accounts in directory</span><strong>{directory.length}</strong></article>{['admin','administrator'].includes(role) && <article className="stat-card"><span>Recent security events</span><strong>{auditEvents.length}</strong></article>}</section>}
      {workspaceConfig.maintenance_mode && role !== 'admin' && role !== 'administrator' && <div className="maintenance-banner">Record entry is temporarily paused for maintenance. Your account and existing records remain available.</div>}
      {role && <section className="card"><h2>{role === 'inputer' ? 'Create a record' : 'Team record entry'}</h2><form onSubmit={createInput}><label>Record details<textarea maxLength={workspaceConfig.max_record_length} rows={3} required value={record} onChange={e=>setRecord(e.target.value)}/></label><small>{record.length} / {workspaceConfig.max_record_length} characters</small><button disabled={busy || (workspaceConfig.maintenance_mode && role !== 'admin' && role !== 'administrator')}>Save draft</button></form></section>}
      <section className="card"><h2>{role === 'inputer' ? 'My records' : 'Team records'}</h2>{inputs.length ? inputs.map(row=><article className="record" key={row.id}><p>{row.content}</p><small>{row.status} · {new Date(row.created_at).toLocaleString()}{role !== 'inputer' ? ` · owner ${row.owner_id}` : ''}</small></article>) : <p className="muted">No records available.</p>}{hasMoreInputs && <button className="secondary" disabled={busy} onClick={loadOlderInputs}>Load older records</button>}</section>
      {role && ['manager','admin','administrator'].includes(role) && <UserManagement role={role} ownUserId={session?.user.id ?? ''} users={directory} busy={busy} onAdd={email=>manageUser('add_inputer',{email})} onDeactivate={userId=>manageUser('deactivate_inputer',{userId})} onAssign={(userId,newRole)=>manageUser('assign_role',{userId,role:newRole})}/>}
      {role && ['admin','administrator'].includes(role) && <section className="card"><h2>Security and role audit</h2><p className="muted">Recent invitations, deactivations, and role changes.</p>{auditEvents.length ? auditEvents.map(item=><article className="record" key={item.id}><p>{item.event.replaceAll('_',' ')}</p><small>{new Date(item.created_at).toLocaleString()} · actor {item.actor_id ?? 'system'} · target {item.target_user_id ?? '—'}{item.details?.from ? ` · ${item.details.from} → ${item.details.to}` : ''}</small></article>) : <p className="muted">No audit events available.</p>}</section>}
      {role && ['admin','administrator'].includes(role) && <section className="card"><h2>Backup history</h2>{backupRuns.length ? backupRuns.map(run=><article className="record" key={run.id}><p>{run.provider} · {run.backup_kind} · {run.status}</p><small>{new Date(run.started_at).toLocaleString()} · {run.artifact_key ?? 'No artifact path yet'}{run.checksum_sha256 ? ` · SHA-256 ${run.checksum_sha256}` : ''}</small></article>) : <p className="muted">No backup runs are recorded yet.</p>}</section>}
      {role && ['admin','administrator'].includes(role) && !configurationAvailable && <section className="card"><h2>Workspace configuration</h2><p className="muted">Apply the workspace configuration migrations in Supabase SQL Editor to enable versioned settings and configuration-only restore.</p></section>}
      {role && ['admin','administrator'].includes(role) && configurationAvailable && <WorkspaceConfiguration config={workspaceConfig} versions={configVersions} canManage={role === 'admin' || role === 'administrator'} busy={busy} onSave={saveWorkspaceConfiguration} onRestore={restoreWorkspaceConfiguration}/>}
    </>}
    <footer>Protected by Supabase Auth, MFA, and database row policies.</footer>
  </main>;
}

function WorkspaceConfiguration({ config, versions, canManage, busy, onSave, onRestore }: { config: ConfigRow; versions: ConfigVersion[]; canManage: boolean; busy: boolean; onSave: (config: Pick<ConfigRow, 'maintenance_mode'|'offline_entry_enabled'|'max_record_length'>, reason: string) => void; onRestore: (id: number, reason: string) => void }) {
  const [maintenanceMode, setMaintenanceMode] = useState(config.maintenance_mode);
  const [offlineEnabled, setOfflineEnabled] = useState(config.offline_entry_enabled);
  const [maxLength, setMaxLength] = useState(String(config.max_record_length));
  const [reason, setReason] = useState('');
  useEffect(() => { setMaintenanceMode(config.maintenance_mode); setOfflineEnabled(config.offline_entry_enabled); setMaxLength(String(config.max_record_length)); }, [config]);
  return <section className="card"><h2>Workspace configuration</h2><p className="muted">Saving or restoring settings does not alter user records. Admins and administrators can change or restore settings.</p><article className="record"><p>{config.maintenance_mode?'Maintenance mode is on':'Normal operation'} · encrypted offline queue {config.offline_entry_enabled?'enabled':'disabled'} · max record length {config.max_record_length}</p><small>Updated {config.updated_at ? new Date(config.updated_at).toLocaleString() : 'with defaults'}</small></article>{canManage&&<form onSubmit={event=>{event.preventDefault();onSave({maintenance_mode:maintenanceMode,offline_entry_enabled:offlineEnabled,max_record_length:Number(maxLength)},reason);setReason('')}}><label className="check-row"><input type="checkbox" checked={maintenanceMode} onChange={event=>setMaintenanceMode(event.target.checked)}/>Pause new record entry</label><label className="check-row"><input type="checkbox" checked={offlineEnabled} onChange={event=>setOfflineEnabled(event.target.checked)}/>Allow encrypted offline queue</label><label>Maximum record length<input type="number" min={100} max={4000} required value={maxLength} onChange={event=>setMaxLength(event.target.value)}/></label><label>Reason for this configuration change<input minLength={3} maxLength={500} required value={reason} onChange={event=>setReason(event.target.value)}/></label><button disabled={busy}>Save configuration version</button></form>}<h3>Previous configuration versions</h3>{versions.length ? versions.map(version=><article className="record" key={version.id}><p>Version {version.id} · {version.maintenance_mode?'maintenance on':'normal operation'} · offline {version.offline_entry_enabled?'on':'off'} · max {version.max_record_length}</p><small>{new Date(version.created_at).toLocaleString()} · {version.reason}</small>{canManage&&<button className="secondary restore-button" disabled={busy} onClick={()=>{const restoreReason=window.prompt(`Why restore configuration version ${version.id}?`);if(restoreReason?.trim())onRestore(version.id,restoreReason.trim())}}>Restore configuration only</button>}</article>) : <p className="muted">No configuration versions yet.</p>}</section>;
}

function dashboardTitle(role: AppRole | null) {
  if (role === 'administrator') return 'SYSTEM ADMINISTRATOR DASHBOARD';
  if (role === 'admin') return 'ADMIN OPERATIONS DASHBOARD';
  if (role === 'manager') return 'MANAGER TEAM DASHBOARD';
  return 'INPUTER PERSONAL DASHBOARD';
}

function dashboardHeading(role: AppRole | null) {
  if (role === 'administrator') return 'System overview';
  if (role === 'admin') return 'Operations overview';
  if (role === 'manager') return 'Team overview';
  return 'My workspace';
}

function UserManagement({ role, ownUserId, users, busy, onAdd, onDeactivate, onAssign }: { role: AppRole; ownUserId:string; users:UserRoleRow[]; busy: boolean; onAdd: (email:string)=>void; onDeactivate:(id:string)=>void; onAssign:(id:string,role:AppRole)=>void }) {
  const [email, setEmail] = useState('');
  const canInvite = ['manager','admin','administrator'].includes(role);
  return <section className="card"><h2>{role === 'manager' ? 'Inputer onboarding' : 'User administration'}</h2>{canInvite && <form onSubmit={e=>{e.preventDefault(); onAdd(email); setEmail('')}}><label>Invite inputer by email<input type="email" required value={email} onChange={e=>setEmail(e.target.value)}/></label><button disabled={busy}>Send invitation</button></form>}{role !== 'manager' && <p className="muted">Admin roles can review the whole team and invite inputers. Deactivation preserves accounts and their records; only the administrator can assign roles.</p>}{users.length ? users.map(user=><article className="userrow" key={user.user_id}><span>{user.email}<small>{user.role} · {user.active ? 'active' : 'inactive'}{user.user_id === ownUserId ? ' · you' : ''}</small></span><span className="actions">{role === 'admin' && user.role === 'inputer' && user.active && user.user_id !== ownUserId && <button className="danger" disabled={busy} onClick={()=>onDeactivate(user.user_id)}>Deactivate</button>}{role === 'administrator' && user.user_id !== ownUserId && <><select aria-label={`Role for ${user.email}`} value={user.role} disabled={!user.active || busy} onChange={e=>onAssign(user.user_id,e.target.value as AppRole)}><option value="inputer">Inputer</option><option value="manager">Manager</option><option value="admin">Admin</option><option value="administrator">Administrator</option></select><button className="danger" disabled={busy || !user.active || user.role !== 'inputer'} onClick={()=>onDeactivate(user.user_id)}>Deactivate</button></>}</span></article>) : <p className="muted">No directory entries available.</p>}</section>;
}
