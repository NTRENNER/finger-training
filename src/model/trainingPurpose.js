// Explain the decision already made; never change the training prescription.
export function trainingPurpose(rec, ladder = null) {
  if (ladder) {
    if (['recalibrate', 'down_step'].includes(ladder.decision)) return {label:'Rebuild consistency', text:'Recent efforts did not support the previous load. This session adjusts the load so you can build consistency.'};
    if (ladder.decision === 'advance') return {label:'Progress a demonstrated ability', text:'You met the ladder gates. Keep the load and add a rep.'};
    if (ladder.decision === 'step_load') return {label:'Progress a demonstrated ability', text:'You completed the top rung. Increase the load and restart at fewer reps.'};
    return {label:'Build consistency', text:ladder.decision === 'incomplete' ? 'The previous session was incomplete. Repeat the rung before advancing.' : 'Repeat this load and rep count until the ladder gates are met.'};
  }
  if (rec?.coldStart || rec?.boundaryProbe || rec?.coverageSnap) return {label:'Fill an evidence gap', text:'This duration needs a clearer measurement. The session updates your estimate; missing evidence does not mean a weakness.'};
  return {label:'Build capacity', text:'This duration is selected from your recent performance and training coverage. It is a training opportunity, not proof that this is your weakest ability.'};
}
