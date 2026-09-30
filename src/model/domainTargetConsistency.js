// Independent progression pins, load bounds and display rounding can overlap.
// Never invent a numeric gap: preserve the training dose and make clear that
// these are starting loads, not two distinct predicted failure times.
export function markUncertainDomainTimes(rows, displayLoad = n => n.toFixed(1)) {
  if (!rows) return rows;
  const uncertain = rows.map(() => new Set());
  rows.forEach((a, i) => rows.forEach((b, j) => {
    if (i >= j || a.deferredReason || b.deferredReason || !(a.T > 0 && b.T > 0) || a.T === b.T) return;
    const [short, long] = a.T < b.T ? [a, b] : [b, a];
    for (const hand of ['L','R']) {
      if (!(short[hand] > 0 && long[hand] > 0)) continue;
      if (long[hand] >= short[hand] || displayLoad(long[hand]) === displayLoad(short[hand])) {
        uncertain[i].add(hand); uncertain[j].add(hand);
      }
    }
  }));
  return rows.map((row, i) => ({...row, uncertainTimeHands: [...uncertain[i]]}));
}

export function progressionLabel(decision) {
  return ({advance:'add a hold', step_load:'increase target', down_step:'ease target',
    recalibrate:'adjust target', incomplete:'repeat to confirm', repeat:'repeat target'})[decision] || 'progression kept';
}
