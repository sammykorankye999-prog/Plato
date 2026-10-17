// Local account-owner recovery utility. Never run this in a browser or deploy it.
// Requires the Supabase project secret key only in this local process environment.
import { createClient } from '@supabase/supabase-js';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const userId = process.env.MFA_RESET_USER_ID;
const expectedEmail = process.env.MFA_RESET_EMAIL?.trim().toLowerCase();

if (!projectUrl || !secretKey || !userId || !expectedEmail) {
  throw new Error('Set NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, MFA_RESET_USER_ID, and MFA_RESET_EMAIL first.');
}

const client = createClient(projectUrl, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: userResult, error: userError } = await client.auth.admin.getUserById(userId);
if (userError || !userResult.user) throw new Error('Could not find that Auth user in this Supabase project.');
if (userResult.user.email?.trim().toLowerCase() !== expectedEmail) {
  throw new Error('The user ID and MFA_RESET_EMAIL do not identify the same account. No factor was removed.');
}

const { data: factorResult, error: factorError } = await client.auth.admin.mfa.listFactors({ userId });
if (factorError) throw new Error(`Could not list MFA factors: ${factorError.message}`);
const totpFactors = factorResult.factors.filter(factor => factor.factor_type === 'totp');
if (totpFactors.length === 0) {
  console.log('No TOTP factors are attached to this account. Sign in to enroll an authenticator.');
  process.exit(0);
}

const terminal = createInterface({ input, output });
try {
  console.log(`Account: ${expectedEmail}`);
  console.log(`TOTP factors to remove: ${totpFactors.length}`);
  console.log('This removes the old authenticator and signs out active sessions.');
  const confirmation = await terminal.question(`Type RESET ${userId} to continue: `);
  if (confirmation !== `RESET ${userId}`) {
    console.log('Cancelled. No MFA factors were removed.');
    process.exitCode = 1;
  } else {
    for (const factor of totpFactors) {
      const { error } = await client.auth.admin.mfa.deleteFactor({ id: factor.id, userId });
      if (error) throw new Error(`Could not remove an authenticator factor: ${error.message}`);
    }
    console.log('Old TOTP factor(s) removed. Request a fresh password reset email, set your password, then sign in.');
    console.log('Because no verified TOTP factor remains, Secure Workspace will show a new QR code for enrollment.');
  }
} finally {
  terminal.close();
}
