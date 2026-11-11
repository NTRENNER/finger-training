// Regression: editing a rep's HAND in History must actually move it and
// not leave the old-hand copy behind. hand is part of the cloud identity
// (session_id,set_num,rep_num,hand), so an in-place update orphaned the
// old slot and reconcile resurrected it — the "R reps revert to L" bug.
// updateRep now models a hand change as delete-old + insert-new.
import { renderHook, act } from "@testing-library/react";
import { useRepHistory } from "../useRepHistory.js";
import { saveLS, loadLS, LS_HISTORY_KEY, LS_REP_DELETED_KEY } from "../../lib/storage.js";

const L = (id, rep_num, hand = "L") => ({
  id, session_id: "s1", date: "2026-07-04", grip: "Crusher", hand,
  set_num: 1, rep_num, target_duration: 45, actual_time_s: 141,
  avg_force_kg: null, manual_load_kg: 23.4, prescribed_load_kg: 23.4, weight_kg: 23.4,
});

beforeEach(() => { try { window.localStorage.clear(); } catch {} });

test("editing hand L→R moves the rep (no leftover L, new id, R slot)", async () => {
  const rep = L("rep-L-5", 5);
  saveLS(LS_HISTORY_KEY, [rep]);

  const { result } = renderHook(() => useRepHistory({ user: null }));
  expect(result.current.history).toHaveLength(1);

  await act(async () => { await result.current.updateRep(rep, { hand: "R" }); });

  const h = result.current.history;
  expect(h).toHaveLength(1);                      // moved, not duplicated
  expect(h.some(r => r.id === "rep-L-5")).toBe(false);  // old id gone
  expect(h[0].hand).toBe("R");                    // now right hand
  expect(h[0].id).not.toBe("rep-L-5");            // fresh id
  expect(h[0].rep_num).toBe(1);                   // first free rep_num on R
  expect(h[0].actual_time_s).toBe(141);           // data preserved
  // old id tombstoned so a reconcile can't resurrect the L copy
  expect(loadLS(LS_REP_DELETED_KEY) || []).toContain("rep-L-5");
});

test("non-hand edit (time) keeps the same rep id (cheap in-place path)", async () => {
  const rep = L("rep-L-9", 9);
  saveLS(LS_HISTORY_KEY, [rep]);
  const { result } = renderHook(() => useRepHistory({ user: null }));
  await act(async () => { await result.current.updateRep(rep, { actual_time_s: 99 }); });
  const h = result.current.history;
  expect(h).toHaveLength(1);
  expect(h[0].id).toBe("rep-L-9");   // same row, in place
  expect(h[0].actual_time_s).toBe(99);
});

// Regression: moving a rep to the other hand tombstones the slot it left.
// Moving it back used "highest rep number + 1" on the original hand, which
// is that same tombstoned slot, so the next sync dropped the rep.
test("moving a rep to the other hand and back does not reuse its tombstoned slot", async () => {
  const reps = [1, 2, 3, 4, 5].map(n => L(`rep-L-${n}`, n));
  saveLS(LS_HISTORY_KEY, reps);
  const { result } = renderHook(() => useRepHistory({ user: null }));

  await act(async () => { await result.current.updateRep(reps[4], { hand: "R" }); });
  const onRight = result.current.history.find(r => r.hand === "R");
  expect(onRight.rep_num).toBe(1);

  await act(async () => { await result.current.updateRep(onRight, { hand: "L" }); });
  const left = result.current.history.filter(r => r.hand === "L");
  expect(left).toHaveLength(5);
  expect(result.current.history.some(r => r.hand === "R")).toBe(false);
  const back = left.find(r => r.actual_time_s === 141 && !/^rep-L-[1-4]$/.test(r.id));
  expect(back.rep_num).toBe(6);   // slot 5 on L is tombstoned
});
