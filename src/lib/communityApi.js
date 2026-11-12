import { supabase } from './supabase.js';
import { ownsLocalSession } from './sync.js';
import { uuid } from '../util.js';

export async function communityRequest(owner, request) {
  if (!ownsLocalSession(owner)) throw new Error('Sign in again to use Community.');
  const { data, error } = await request();
  if (!ownsLocalSession(owner)) throw new Error('Account changed.');
  if (error) throw error;
  return data;
}

export async function ensureCommunityProfile(owner) {
  const read = () => communityRequest(owner, () => supabase.from('community_profiles').select('*').eq('user_id', owner).maybeSingle());
  let profile = await read();
  if (profile) return profile;
  await communityRequest(owner, () => supabase.from('community_profiles').upsert({
    user_id: owner, display_name: `Climber ${uuid().slice(0, 6)}`,
  }, { onConflict: 'user_id', ignoreDuplicates: true }));
  profile = await read();
  if (!profile) throw new Error('Community profile unavailable.');
  return profile;
}

export const saveCommunityProfile = (owner, patch) => communityRequest(owner, () =>
  supabase.from('community_profiles').update(patch).eq('user_id', owner).select('*').single());
export const syncCommunity = (owner, achievements, peaks, progress = []) => communityRequest(owner, () =>
  supabase.rpc('sync_community', { p_achievements: achievements, p_peaks: peaks, p_progress: progress }));
export const readCommunityFeed = (owner, grip = null, cursor = null) => communityRequest(owner, () =>
  supabase.rpc('community_feed', { p_grip: grip, p_before: cursor?.created_at ?? null, p_before_id: cursor?.id ?? null }));
export const readCommunityRanking = (owner, grip, hand = null) => communityRequest(owner, () =>
  supabase.rpc('community_ranking', { p_grip: grip, p_hand: hand }));
export const readCommunityGroups = (owner, grip) => communityRequest(owner, () =>
  supabase.rpc('community_improvement_groups', { p_grip: grip }));
export const readCommunityImprovements = (owner, grip, group) => communityRequest(owner, () =>
  supabase.rpc('community_improvement_ranking', { p_grip: grip,
    p_baseline_band: group.baseline_band, p_support_keys: group.support_keys }));
export const hideCommunityCard = (owner, id) => communityRequest(owner, () =>
  supabase.from('community_achievements').update({ hidden: true }).eq('id', id).eq('user_id', owner));
export const celebrateCommunityCard = (owner, id, remove) => communityRequest(owner, () => remove
  ? supabase.from('community_celebrations').delete().eq('achievement_id', id).eq('user_id', owner)
  : supabase.from('community_celebrations').upsert({ achievement_id: id, user_id: owner }, { onConflict: 'achievement_id,user_id', ignoreDuplicates: true }));
