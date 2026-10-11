import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import * as Crypto from 'expo-crypto';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { localQueue } from '../lib/offline';

type Stage = 'loading'|'signin'|'enroll'|'challenge'|'workspace';
type AppRole = 'inputer'|'manager'|'admin'|'administrator';
type InputRow = { id:string; content:string; status:string; created_at:string };

export default function Home() {
  const [stage,setStage]=useState<Stage>('loading'); const [session,setSession]=useState<Session|null>(null);
  const [email,setEmail]=useState(''); const [password,setPassword]=useState(''); const [code,setCode]=useState('');
  const [factorId,setFactorId]=useState(''); const [challengeId,setChallengeId]=useState(''); const [qrCode,setQrCode]=useState('');
  const [role,setRole]=useState<AppRole|null>(null); const [content,setContent]=useState(''); const [inputs,setInputs]=useState<InputRow[]>([]);
  const [message,setMessage]=useState(''); const [busy,setBusy]=useState(false);

  const loadData=useCallback(async(active:Session)=>{
    setSession(active);
    const {data:roleRow,error:roleError}=await supabase.from('user_roles').select('role').eq('user_id',active.user.id).maybeSingle();if(roleError)throw roleError;
    setRole(roleRow?.role??null);
    if(roleRow){const {data:rows,error:inputError}=await supabase.from('inputs').select('id,content,status,created_at').order('created_at',{ascending:false}).limit(30);if(inputError)throw inputError;setInputs(rows??[]);}
    setStage('workspace');setMessage(roleRow?'':'No application role is assigned. Contact an administrator.');
  },[]);

  const prepareFactor=useCallback(async(active:Session)=>{
    setSession(active);
    const {data:aal,error:aalError}=await supabase.auth.mfa.getAuthenticatorAssuranceLevel(); if(aalError) throw aalError;
    if(aal.currentLevel==='aal2'){await loadData(active);return;}
    const {data:factors,error:factorError}=await supabase.auth.mfa.listFactors(); if(factorError) throw factorError;
    const verified=factors.totp.find(f=>f.status==='verified');
    if(verified){const {data,error}=await supabase.auth.mfa.challenge({factorId:verified.id});if(error)throw error;setFactorId(verified.id);setChallengeId(data.id);setStage('challenge');return;}
    const {data,error}=await supabase.auth.mfa.enroll({factorType:'totp',friendlyName:'Authenticator'});if(error)throw error;
    setFactorId(data.id);setQrCode(data.totp.qr_code);setStage('enroll');
  },[loadData]);

  useEffect(()=>{
    let active=true;
    supabase.auth.getSession().then(({data,error})=>{if(!active)return;if(error){setMessage(error.message);setStage('signin');}else if(data.session)prepareFactor(data.session).catch(e=>{setMessage(e.message);setStage('signin');});else setStage('signin');});
    const {data:listener}=supabase.auth.onAuthStateChange((event)=>{if(!active)return;if(event==='SIGNED_OUT'){setSession(null);setRole(null);setStage('signin');}});
    return()=>{active=false;listener.subscription.unsubscribe();};
  },[prepareFactor]);

  async function signIn(){setBusy(true);setMessage('');try{const {data,error}=await supabase.auth.signInWithPassword({email:email.trim(),password});if(error)throw error;if(data.session)await prepareFactor(data.session);}catch(e){setMessage((e as Error).message);}finally{setBusy(false);}}
  async function googleSignIn(){setBusy(true);setMessage('');try{
    const redirectTo=Linking.createURL('auth/callback');
    const {data,error}=await supabase.auth.signInWithOAuth({provider:'google',options:{redirectTo,skipBrowserRedirect:true}});if(error)throw error;
    if(!data.url)throw new Error('Google sign-in URL was not returned.');
    const result=await WebBrowser.openAuthSessionAsync(data.url,redirectTo);
    if(result.type!=='success')return;
    const authCode=new URL(result.url).searchParams.get('code');if(!authCode)throw new Error('OAuth callback did not include an authorization code.');
    const {data:exchange,error:exchangeError}=await supabase.auth.exchangeCodeForSession(authCode);if(exchangeError)throw exchangeError;
    if(exchange.session)await prepareFactor(exchange.session);
  }catch(e){setMessage((e as Error).message);}finally{setBusy(false);}}

  async function verifyCode(){setBusy(true);setMessage('');try{let challenge=challengeId;if(!challenge){const {data,error}=await supabase.auth.mfa.challenge({factorId});if(error)throw error;challenge=data.id;}
    const {error}=await supabase.auth.mfa.verify({factorId,challengeId:challenge,code:code.trim()});if(error)throw error;
    setCode('');setQrCode('');setChallengeId('');const {data:verified,error:sessionError}=await supabase.auth.getSession();if(sessionError)throw sessionError;if(verified.session)await loadData(verified.session);
  }catch(e){setMessage((e as Error).message);}finally{setBusy(false);}}

  async function saveOnline(){if(!session||!role){setMessage('No active application role.');return;}setBusy(true);setMessage('');
    const {error}=await supabase.from('inputs').insert({owner_id:session.user.id,content:content.trim()});
    if(error){setMessage(error.message);setBusy(false);return;}setContent('');await loadData(session);setBusy(false);
  }
  async function saveOffline(){if(!session||!role||!content.trim()){setMessage('Complete MFA and sign in with an assigned role before saving a queued entry.');return;}try{
    const db=await localQueue();await db.runAsync('INSERT INTO pending_inputs(id,owner_id,content,created_at) VALUES(?,?,?,?)',Crypto.randomUUID(),session.user.id,content.trim(),new Date().toISOString());
    setContent('');setMessage('Saved encrypted on this device. It remains pending until you sync online; access will be checked by Supabase.');
  }catch(e){setMessage((e as Error).message);}}
  async function syncOffline(){if(!session)return;setBusy(true);try{const db=await localQueue();const pending=await db.getAllAsync<{id:string;owner_id:string;content:string}>('SELECT id,owner_id,content FROM pending_inputs WHERE sync_state=\'pending\' ORDER BY created_at');
    let count=0;for(const row of pending){const {error}=await supabase.from('inputs').insert({owner_id:row.owner_id,content:row.content});if(error){setMessage(`Sync stopped. Server authorization or connection failed: ${error.message}`);break;}await db.runAsync('DELETE FROM pending_inputs WHERE id=?',row.id);count++;}
    if(count)await loadData(session);setMessage(count?`Synced ${count} pending record(s).`:(message||'No pending records were synced.'));
  }catch(e){setMessage((e as Error).message);}finally{setBusy(false);}}

  if(stage==='loading')return <View style={styles.center}><ActivityIndicator/><Text>Checking sign-in…</Text></View>;
  return <ScrollView contentContainerStyle={styles.page}>
    <Text style={styles.brand}>SECURE WORKSPACE</Text>
    {message? <Text accessibilityRole="alert" style={styles.notice}>{message}</Text>:null}
    {stage==='signin'&&<View style={styles.card}><Text style={styles.title}>Sign in securely.</Text><Text style={styles.muted}>Use your invited account. A TOTP code is required before data access.</Text>
      <TextInput style={styles.input} placeholder="Email" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail}/><TextInput style={styles.input} placeholder="Password" secureTextEntry value={password} onChangeText={setPassword}/>
      <Pressable style={styles.button} disabled={busy} onPress={signIn}><Text style={styles.buttonText}>Continue with password</Text></Pressable><Pressable style={styles.secondary} disabled={busy} onPress={googleSignIn}><Text>Continue with Google</Text></Pressable></View>}
    {(stage==='enroll'||stage==='challenge')&&<View style={styles.card}><Text style={styles.title}>{stage==='enroll'?'Set up your authenticator':'Enter your code'}</Text><Text style={styles.muted}>{stage==='enroll'?'Scan the QR code, then enter a current six-digit code.':'Open your authenticator app and enter the current six-digit code.'}</Text>{qrCode?<Image source={{uri:qrCode}} style={styles.qr}/>:null}<TextInput style={styles.input} placeholder="000000" keyboardType="number-pad" maxLength={6} value={code} onChangeText={setCode}/><Pressable style={styles.button} disabled={busy} onPress={verifyCode}><Text style={styles.buttonText}>Verify and continue</Text></Pressable></View>}
    {stage==='workspace'&&<><View style={styles.card}><Text style={styles.title}>Welcome</Text><Text style={styles.muted}>{session?.user.email} · {role??'role pending'}</Text><Pressable style={styles.secondary} onPress={()=>supabase.auth.signOut()}><Text>Sign out</Text></Pressable></View>
      {role&&<View style={styles.card}><Text style={styles.section}>New input</Text><TextInput style={[styles.input,styles.multiline]} multiline maxLength={4000} placeholder="Record details" value={content} onChangeText={setContent}/><Pressable style={styles.button} disabled={busy} onPress={saveOnline}><Text style={styles.buttonText}>Save online</Text></Pressable><Pressable style={styles.secondary} onPress={saveOffline}><Text>Save encrypted offline</Text></Pressable><Pressable style={styles.secondary} disabled={busy} onPress={syncOffline}><Text>Sync pending records</Text></Pressable></View>}
      <View style={styles.card}><Text style={styles.section}>Recent records</Text>{inputs.map(row=><View key={row.id} style={styles.row}><Text>{row.content}</Text><Text style={styles.muted}>{row.status} · {new Date(row.created_at).toLocaleString()}</Text></View>)}</View></>}
    <Text style={styles.footer}>Offline entries are encrypted locally. Role and MFA authorization are rechecked by the server when syncing.</Text>
  </ScrollView>;
}

const styles=StyleSheet.create({page:{flexGrow:1,backgroundColor:'#f5f8f7',padding:22,paddingTop:54},center:{flex:1,alignItems:'center',justifyContent:'center',gap:12},brand:{fontSize:13,fontWeight:'800',letterSpacing:2,color:'#176b55',marginBottom:25},card:{backgroundColor:'#fff',borderColor:'#dbe3e5',borderWidth:1,borderRadius:16,padding:21,marginBottom:15},title:{fontSize:30,fontWeight:'800',color:'#142d3a',marginBottom:8},section:{fontSize:19,fontWeight:'800',color:'#142d3a',marginBottom:10},muted:{color:'#647681',fontSize:13,marginBottom:8},input:{borderColor:'#cad6da',borderWidth:1,borderRadius:9,padding:13,marginTop:12,marginBottom:4,color:'#142d3a',backgroundColor:'#fff'},multiline:{minHeight:90,textAlignVertical:'top'},button:{backgroundColor:'#176b55',padding:14,borderRadius:9,alignItems:'center',marginTop:14},buttonText:{color:'#fff',fontWeight:'700'},secondary:{backgroundColor:'#e8f0ed',padding:13,borderRadius:9,alignItems:'center',marginTop:10},qr:{width:210,height:210,alignSelf:'center',margin:12},notice:{backgroundColor:'#e8f0ed',padding:12,borderRadius:9,marginBottom:15,color:'#142d3a'},row:{borderTopColor:'#edf1f2',borderTopWidth:1,paddingVertical:11},footer:{color:'#647681',fontSize:11,marginTop:10,marginBottom:28}});
