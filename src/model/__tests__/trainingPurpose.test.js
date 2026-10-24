import {trainingPurpose} from '../trainingPurpose.js';
test('purpose follows ladder rather than a coverage pick it overrides',()=>{
 expect(trainingPurpose({coverageSnap:true},{decision:'advance'}).label).toBe('You hit your target');
 expect(trainingPurpose({},{decision:'step_load'}).text).toMatch(/Increase the load/);
 expect(trainingPurpose({},{decision:'recalibrate'}).label).toBe('Rebuild consistency');
 expect(trainingPurpose({},{decision:'down_step'}).label).toBe('Rebuild consistency');
 expect(trainingPurpose({},{decision:'repeat'}).label).toBe('Build consistency');
});
test('an overshoot claims a heavier load only when the resolved load is heavier',()=>{
 const ladder={decision:'recalibrate_up',previousLoadByHand:{L:16.8},basis:{overshootHands:['L']}};
 expect(trainingPurpose({},ladder,{L:20.2}).label).toBe('You outperformed the load');
 expect(trainingPurpose({},ladder,{L:16.8}).label).toBe('Build consistency');
});
test('evidence collection is labeled without claiming a weakness',()=>{
 for(const rec of [{coldStart:true},{boundaryProbe:true},{coverageSnap:true}]) expect(trainingPurpose(rec).label).toBe('More data needed');
 expect(trainingPurpose({}).label).toBe('Build capacity');
});
