import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const allowedOrigins = (Deno.env.get('APP_ORIGINS') ?? '').split(',').map(origin => origin.trim()).filter(Boolean);

Deno.serve(async (request) => {
  const origin = request.headers.get('Origin') ?? '';
  if (!allowedOrigins.includes(origin)) return new Response('Origin not allowed', { status: 403 });
  const corsHeaders = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);

  try {
    const authorization = request.headers.get('Authorization');
    if (!authorization?.startsWith('Bearer ')) return response({ error: 'Sign-in required' }, 401);
    const token = authorization.slice('Bearer '.length);
    const url = Deno.env.get('SUPABASE_URL')!;
    const publishableKeys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}');
    const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    const publishableKey = publishableKeys.default ?? Deno.env.get('SUPABASE_ANON_KEY');
    const secretKey = secretKeys.default ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!publishableKey || !secretKey) return response({ error: 'Server credentials are not configured' }, 500);

    const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: claimData, error: claimError } = await admin.auth.getClaims(token);
    const claims = claimData?.claims;
    if (claimError || !claims?.sub || claims.aal !== 'aal2') {
      return response({ error: 'A verified second factor is required' }, 403);
    }

    const { data: callerRole, error: roleError } = await admin
      .from('user_roles').select('role,active').eq('user_id', claims.sub).maybeSingle();
    if (roleError || !callerRole?.active) return response({ error: 'Active role required' }, 403);

    const body = await request.json();
    if (body.action === 'add_inputer') {
      if (callerRole.role !== 'manager') return response({ error: 'Only managers can invite inputers' }, 403);
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response({ error: 'Enter a valid email address' }, 400);
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
        redirectTo: Deno.env.get('WEB_ORIGIN'),
      });
      if (error || !data.user) return response({ error: error?.message ?? 'Invitation failed' }, 400);
      const { error: assignmentError } = await admin.from('user_roles').upsert({
        user_id: data.user.id,
        email,
        role: 'inputer',
        invited_by: claims.sub,
      }, { onConflict: 'user_id', ignoreDuplicates: true });
      if (assignmentError) {
        await admin.auth.admin.deleteUser(data.user.id);
        return response({ error: 'Could not assign the inputer role' }, 500);
      }
      await admin.from('audit_events').insert({ actor_id: claims.sub, target_user_id: data.user.id, event: 'inputer_invited' });
      return response({ ok: true, userId: data.user.id });
    }

    if (body.action === 'deactivate_inputer') {
      if (!['admin', 'administrator'].includes(callerRole.role)) return response({ error: 'Not authorized' }, 403);
      const targetId = typeof body.userId === 'string' ? body.userId : '';
      const { data: target, error: targetError } = await admin.from('user_roles')
        .select('user_id,role,active').eq('user_id', targetId).maybeSingle();
      if (targetError || !target || target.role !== 'inputer') return response({ error: 'Only an inputer can be deactivated here' }, 404);
      if (target.user_id === claims.sub) return response({ error: 'You cannot deactivate yourself' }, 400);
      const { error: banError } = await admin.auth.admin.updateUserById(target.user_id, { ban_duration: '876000h' });
      if (banError) return response({ error: 'Could not disable sign-in for this account' }, 500);
      const { error: updateError } = await admin.from('user_roles').update({ active: false }).eq('user_id', target.user_id);
      if (updateError) return response({ error: 'Could not deactivate the account' }, 500);
      await admin.from('audit_events').insert({ actor_id: claims.sub, target_user_id: target.user_id, event: 'inputer_deactivated' });
      return response({ ok: true });
    }

    if (body.action === 'assign_role') {
      if (callerRole.role !== 'administrator') return response({ error: 'Only an administrator can assign roles' }, 403);
      const targetId = typeof body.userId === 'string' ? body.userId : '';
      const newRole = typeof body.role === 'string' ? body.role : '';
      if (!['inputer', 'manager', 'admin', 'administrator'].includes(newRole)) return response({ error: 'Unknown role' }, 400);
      if (targetId === claims.sub) return response({ error: 'You cannot change your own role' }, 400);
      const { data: target, error: targetError } = await admin.from('user_roles')
        .select('user_id,role,active').eq('user_id', targetId).maybeSingle();
      if (targetError || !target || !target.active) return response({ error: 'Active account not found' }, 404);
      if (target.role === 'administrator' && newRole !== 'administrator') {
        const { count, error: countError } = await admin.from('user_roles')
          .select('user_id', { count: 'exact', head: true }).eq('role', 'administrator').eq('active', true);
        if (countError || (count ?? 0) < 2) return response({ error: 'The last active administrator cannot be demoted' }, 409);
      }
      const { error: updateError } = await admin.from('user_roles').update({ role: newRole }).eq('user_id', target.user_id);
      if (updateError) return response({ error: 'Could not update the role' }, 500);
      await admin.from('audit_events').insert({ actor_id: claims.sub, target_user_id: target.user_id, event: 'role_changed', details: { from: target.role, to: newRole } });
      return response({ ok: true });
    }

    return response({ error: 'Unknown action' }, 400);
  } catch {
    return response({ error: 'Request could not be completed' }, 400);
  }

  function response(payload: unknown, status = 200) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
});
