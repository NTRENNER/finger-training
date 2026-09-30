import { markUncertainDomainTimes } from '../domainTargetConsistency.js';
const rows=[{T:160,L:8,R:6.3},{T:220,L:6.4,R:6.3}];
test('equal targets are explicitly uncertain for the affected hand without changing the dose',()=>{
 const result=markUncertainDomainTimes(rows);
 expect(result.map(r=>r.uncertainTimeHands)).toEqual([['R'],['R']]);
 result.forEach((r,i)=>expect(r).toMatchObject(rows[i]));
 expect(rows[0].uncertainTimeHands).toBeUndefined();
});
test('flags inversions and display rounding, but does not manufacture a gap',()=>{
 const result=markUncertainDomainTimes([{T:220,L:9,R:5.001},{T:160,L:8,R:5.002}]);
 expect(result.map(r=>r.uncertainTimeHands)).toEqual([['L','R'],['L','R']]);
});
test('distinct descending targets and unavailable domains need no warning',()=>{
 expect(markUncertainDomainTimes([{T:160,L:8},{T:220,L:6}]).every(r=>!r.uncertainTimeHands.length)).toBe(true);
 expect(markUncertainDomainTimes([{T:160,L:8},{T:220,L:8,deferredReason:'peak first'}])[0].uncertainTimeHands).toEqual([]);
});
