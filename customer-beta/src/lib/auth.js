import { createClient } from '@supabase/supabase-js';

const url = import.meta.env?.VITE_SUPABASE_URL || '';
const publishableKey = import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY || '';
export const authConfigured = Boolean(url && publishableKey);
export const supabase = authConfigured ? createClient(url, publishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }) : null;

export async function restoreSession() {
  if (!supabase) return { session: null, user: null };
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return { session: data.session, user: data.session?.user || null };
}
export async function signUp(email, password) {
  if (!supabase) throw new Error('Accounts are not configured in this build.');
  const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
  if (error) throw error;
  return data;
}
export async function signIn(email, password) {
  if (!supabase) throw new Error('Accounts are not configured in this build.');
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}
export async function signOut() {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}
export async function resetPassword(email) {
  if (!supabase) throw new Error('Accounts are not configured in this build.');
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
  if (error) throw error;
}
export function subscribeAuth(callback) {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => callback(session?.user || null, session?.access_token || null));
  return () => data.subscription.unsubscribe();
}
