// Session-to-session opener evidence and within-set repetition evidence stay
// separate. Neither is a claim that today's athlete is recovered.
export function sessionPerformanceContext(progress) {
  const opening=[progress?.force?.state,progress?.duration?.state];
  const lower=opening.includes('lower');
  const improving=opening.includes('improving');
  const known=opening.some(s=>['improving','lower','unchanged'].includes(s));
  let text;
  if(lower && improving) text='Recent opening comparisons are mixed across force and duration.';
  else if(lower) text='Comparable opening performance is lower across recent sessions. Use how you feel today when setting the load.';
  else if(known) text='Comparable opening performance is holding steady or improving across recent sessions.';
  else text='There are not enough comparable opening efforts to assess the recent session-to-session trend.';
  if(progress?.repeat?.state==='lower') text+=' Later-rep performance is lower at comparable force and rest; this describes within-set recovery.';
  return text+' This does not establish readiness today; the cookedness input remains your adjustment.';
}
