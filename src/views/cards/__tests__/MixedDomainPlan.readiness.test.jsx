import React from 'react';
import {render,screen,within} from '@testing-library/react';
import {MixedDomainPlan} from '../MixedDomainPlan.jsx';
import {makeMixedDomainPlan,MIXED_DOMAIN_ZONES} from '../../../model/mixedDomain.js';
import {mixedPlanReadiness} from '../../../model/mixedLoadPrescription.js';
import {predForceThreeExp} from '../../../model/threeExp.js';
const plan = makeMixedDomainPlan(MIXED_DOMAIN_ZONES.map(key=>({key,L:20,R:20})), 'power', ['L','R']);
const h = [10,30,70,115,160,220].map((t,i)=>({id:String(i),session_id:String(i),date:`2026-09-${10+i}`,
  grip:'Micro',hand:'L',rep_num:1,actual_time_s:t,avg_force_kg:predForceThreeExp([18,15,25],t),
  load_provenance:'measured_force',failure_valid:true,force_recording:{capacity_eligible:true}}));
const renderPlan=history=>render(<MixedDomainPlan plan={plan} hands={['L','R']} unit="kg" multiplier={1}
  readiness={mixedPlanReadiness(history,'Micro',['L','R'],plan,'2026-09-23')} onOpeningChange={jest.fn()}/>);
test('ready preview describes a conditional total rather than an assured session length',()=>{
 renderPlan([...h,...h.map(r=>({...r,id:r.id+'R',hand:'R'}))]);
 expect(screen.getByText(/Time if all targets are reached: 23:50 for both hands/)).toBeInTheDocument();
 expect(screen.getAllByText('Reference · adjustment estimated before this hold')).toHaveLength(8);
});
test('partial readiness identifies each affected hand and duration without promising a budget',()=>{
 renderPlan(h.filter(r=>r.actual_time_s<=160));
 expect(screen.queryByText(/23:50/)).not.toBeInTheDocument();
 const left=within(screen.getByRole('list',{name:'Left hand holds'})),right=within(screen.getByRole('list',{name:'Right hand holds'}));
 expect(left.getAllByText('Reference · adjustment estimated before this hold')).toHaveLength(3);
 expect(left.getByText(/outside the measured range/)).toBeInTheDocument();
 expect(right.getAllByText(/More measured history is needed for this hand/)).toHaveLength(4);
});
