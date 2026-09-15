import {useMemo} from 'react';
import {useGripFits} from './useGripFits.js';
import {useHistoryOverlay} from './useHistoryOverlay.js';
import {buildThreeExpPriors} from '../model/threeExp.js';
import {isCapacityEvidenceRep} from '../model/forceRecording.js';
import {extendProgressOverlay} from '../model/progressContinuity.js';
import {ymdLocal} from '../util.js';

export function useContinuousProgress({history,grips,pinnedGripBaselines,pinnedPerHandBaselines}) {
  const today=ymdLocal(new Date());
  const visible=useMemo(()=>history.filter(r=>r.date && r.date<=today),[history,today]);
  const displayHistory=useMemo(()=>{
    const older=new Set(visible.filter(r=>isCapacityEvidenceRep(r) && r.force_recording?.basis!=='target_acquired').map(r=>r.grip));
    return visible.filter(r=>!older.has(r.grip) || r.force_recording?.basis!=='target_acquired');
  },[visible]);
  const priors=useMemo(()=>buildThreeExpPriors(displayHistory),[displayHistory]);
  const fits=useGripFits({history:displayHistory,grips,threeExpPriors:priors,pinnedGripBaselines,pinnedPerHandBaselines,allowAutoPin:false});
  const {historyOverlay:historical}=useHistoryOverlay({history:displayHistory,grips,threeExpPriors:priors,
    gripBaselines:fits.gripBaselines,perHandGripBaselines:fits.perHandGripBaselines});
  const historyOverlay=useMemo(()=>Object.fromEntries(Object.entries(historical).map(([grip,branch])=>[grip,{
    ...extendProgressOverlay(branch,visible,grip),
    perHand:Object.fromEntries(Object.entries(branch.perHand || {}).map(([hand,b])=>[hand,extendProgressOverlay(b,visible,grip,hand)]))
  }])),[historical,visible]);
  return {...fits,historyOverlay,displayHistory};
}
