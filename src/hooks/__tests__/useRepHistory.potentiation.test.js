import { act, renderHook } from '@testing-library/react';
import { useRepHistory } from '../useRepHistory.js';
import { saveLS, loadLS, LS_HISTORY_KEY } from '../../lib/storage.js';
import { POTENTIATION_PROTOCOL_ID, POTENTIATION_PROTOCOL_VERSION } from '../../model/potentiationRfd.js';

beforeEach(() => localStorage.clear());

test('potentiation rows are stored and synced but never reach training history or the curve inputs', async () => {
  const training = { id: 't', session_id: 's', date: '2026-10-20', grip: 'Crusher', hand: 'L', set_num: 1, rep_num: 1,
    target_duration: 45, actual_time_s: 40, avg_force_kg: 35, peak_force_kg: 37, failure_valid: true };
  saveLS(LS_HISTORY_KEY, [training]);
  const { result } = renderHook(() => useRepHistory({ user: null }));
  const before = { fp: result.current.freshMapFp, priors: result.current.threeExpPriors, fresh: result.current.freshMap };

  // Numbered like a fresh first-set rep on purpose: the separation must come
  // from the protocol tag, not from set numbering.
  const pull = { id: 'p', session_id: 'pot_1', date: '2026-10-23', grip: 'Crusher', hand: 'L', set_num: 1, rep_num: 1,
    target_duration: 0, actual_time_s: 1.2, peak_force_kg: 40, failure_valid: false,
    force_recording: { session_protocol: { id: POTENTIATION_PROTOCOL_ID, version: POTENTIATION_PROTOCOL_VERSION } } };
  await act(async () => { await result.current.addReps([pull]); });

  expect(result.current.history.map(r => r.id)).toEqual(['t']);
  expect(result.current.potentiationHistory.map(r => r.id)).toEqual(['p']);
  expect(result.current.allHistory.map(r => r.id).sort()).toEqual(['p', 't']);
  expect(loadLS(LS_HISTORY_KEY).map(r => r.id).sort()).toEqual(['p', 't']);
  expect(result.current.freshMapFp).toBe(before.fp);
  expect(result.current.threeExpPriors).toBe(before.priors);
  expect(result.current.freshMap).toBe(before.fresh);
});
