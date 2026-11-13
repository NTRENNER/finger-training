import { readCommunityRanking } from '../communityApi.js';
import { supabase } from '../supabase.js';
import { ownsLocalSession } from '../sync.js';
jest.mock('../supabase.js', () => ({ supabase: { rpc: jest.fn() } }));
jest.mock('../sync.js', () => ({ ownsLocalSession: jest.fn() }));

test('peak view requests server-ranked improvement, preserving grip/hand and account boundaries', async () => {
  ownsLocalSession.mockReturnValue(true);
  const rows = [{ user_id: 'a', improvement_pct: 25, place: 1 }];
  supabase.rpc.mockResolvedValue({ data: rows, error: null });
  expect(await readCommunityRanking('a', 'Crusher', 'L')).toEqual(rows);
  expect(supabase.rpc).toHaveBeenLastCalledWith('community_peak_improvement_ranking', { p_grip: 'Crusher', p_hand: 'L' });
  await readCommunityRanking('a', 'Prime');
  expect(supabase.rpc).toHaveBeenLastCalledWith('community_peak_improvement_ranking', { p_grip: 'Prime', p_hand: null });
  ownsLocalSession.mockReturnValueOnce(true).mockReturnValueOnce(false);
  await expect(readCommunityRanking('a', 'Crusher')).rejects.toThrow('Account changed.');
});
