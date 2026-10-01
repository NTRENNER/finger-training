import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SessionPlanCard } from '../SessionPlanCard.jsx';
import { ZONE_REF_T, TRAINING_ZONE_KEYS } from '../../../model/zones.js';
jest.mock('../../../model/coaching.js', () => ({ coachingRecommendationContinuous: () => ({
  zone:'strength_endurance', T:160, loadByHand:{L:8,R:6.3}, reasons:[],
}) }));
jest.mock('../../../model/prescription.js',()=>({
 ...jest.requireActual('../../../model/prescription.js'),
 prescription: (h,hand,grip,T)=>({value:hand==='L'?120/T:6.3,reliability:'well-supported'}),
}));
const goals=Object.fromEntries(TRAINING_ZONE_KEYS.map(key=>[key,{label:key,color:'#fff',refTime:ZONE_REF_T[key]}]));
test('overlapping target loads are labeled uncertain and alternate training stays selectable',()=>{
 const apply=jest.fn();
 render(<SessionPlanCard history={[]} grip="Micro" hand="Both" unit="kg" GOAL_CONFIG={goals} onApplyPlan={apply}/>);
 const se=screen.getByRole('button',{name:'Train strength_endurance at 160 seconds'});
 const en=screen.getByRole('button',{name:'Train endurance at 220 seconds'});
 expect(within(se).getByText(/R: Starting load · hold time uncertain/)).toBeInTheDocument();
 expect(within(en).getByText(/R: Starting load · hold time uncertain/)).toBeInTheDocument();
 fireEvent.click(en);
 expect(apply.mock.calls.at(-1)[0]).toMatchObject({goal:'endurance',targetTime:220});
});
