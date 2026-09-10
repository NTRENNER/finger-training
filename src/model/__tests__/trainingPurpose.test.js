import {trainingPurpose} from '../trainingPurpose.js';
test('purpose follows ladder rather than a coverage pick it overrides',()=>{
 expect(trainingPurpose({coverageSnap:true},{decision:'advance'}).label).toBe('Progress a demonstrated ability');
 expect(trainingPurpose({},{decision:'step_load'}).text).toMatch(/Increase the load/);
 expect(trainingPurpose({},{decision:'recalibrate'}).label).toBe('Rebuild consistency');
 expect(trainingPurpose({},{decision:'down_step'}).label).toBe('Rebuild consistency');
 expect(trainingPurpose({},{decision:'repeat'}).label).toBe('Build consistency');
});
test('evidence collection is labeled without claiming a weakness',()=>{
 for(const rec of [{coldStart:true},{boundaryProbe:true},{coverageSnap:true}]) expect(trainingPurpose(rec).label).toBe('Fill an evidence gap');
 expect(trainingPurpose({}).label).toBe('Build capacity');
});
