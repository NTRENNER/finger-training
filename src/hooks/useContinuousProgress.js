import {useMemo} from 'react';
import {useGripFits} from './useGripFits.js';
import {useHistoryOverlay} from './useHistoryOverlay.js';
import {buildThreeExpPriors} from '../model/threeExp.js';
import {ymdLocal} from '../util.js';

// Baselines, fits and the date-by-date overlay the Curve Improvement card
// reads, over ONE comparable series.
//
// This used to hold a second, parallel history: for a grip that spanned the
// recording-basis change it dropped the new-method reps, rebuilt progress from
// the older ones, and chained a separately-measured ratio on top so the
// six-domain card survived the transition. That layer existed only because
// `comparableCapacityHistory` discarded a grip's earlier reps the moment it
// saw a target-acquired one. It no longer does — v3 reps are converted onto
// the earlier whole-pull interval instead — so every rep is already in one
// series and there is nothing left to chain. The card keeps its domains
// because the history is intact, not because a ratio was carried across it.
//
// Kept as a hook rather than inlined at the call site so AnalysisView has one
// place to ask for "the progress view of history".
export function useContinuousProgress({history,grips,pinnedGripBaselines,pinnedPerHandBaselines}) {
  const today=ymdLocal(new Date());
  // Future-dated rows can appear after clock skew or an edited import; they
  // would otherwise seed a baseline the athlete cannot yet have earned.
  const visible=useMemo(()=>history.filter(r=>r.date && r.date<=today),[history,today]);
  const priors=useMemo(()=>buildThreeExpPriors(visible),[visible]);
  const fits=useGripFits({history:visible,grips,threeExpPriors:priors,
    pinnedGripBaselines,pinnedPerHandBaselines,allowAutoPin:false});
  const {historyOverlay}=useHistoryOverlay({history:visible,grips,threeExpPriors:priors,
    gripBaselines:fits.gripBaselines,perHandGripBaselines:fits.perHandGripBaselines});
  return {...fits,historyOverlay,displayHistory:visible};
}
