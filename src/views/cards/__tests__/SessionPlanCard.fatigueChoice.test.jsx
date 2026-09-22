import React, {useState} from 'react';
import {render, screen, fireEvent, within} from '@testing-library/react';
import {SessionPlanCard} from '../SessionPlanCard.js';
jest.mock('../../../model/prescription.js',()=>({prescription:()=>({value:20})}));
jest.mock('../../../model/coaching.js',()=>({coachingRecommendationContinuous:()=>({
  zone:'power',T:45,loadKg:20,loadByHand:{L:20,R:20},reasons:[],
})}));
const goals={power:{label:'Power',emoji:'P',color:'#e05560',refTime:30}};
function Harness() {
  const [cooked,setCooked]=useState(null);
  const [adjust,setAdjust]=useState(false);
  return <SessionPlanCard history={[]} grip="Micro" unit="kg" GOAL_CONFIG={goals}
    cooked={cooked} onCookedChange={setCooked} adjustLoadForFatigue={adjust} onAdjustLoadChange={setAdjust} />;
}
test('rating is separate from load choice, and both the recommendation and alternatives preview the choice',()=>{
  render(<Harness/>);
  const recommendation=screen.getByRole('button',{name:'Use recommended session'});
  expect(screen.queryByRole('group',{name:'Adjust load for fatigue'})).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('slider',{name:/Cookedness/}),{target:{value:'8'}});
  expect(screen.getByRole('button',{name:'Keep recommended load'})).toHaveAttribute('aria-pressed','true');
  expect(within(recommendation).getByText('20.0')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Adjust load accordingly'}));
  expect(within(recommendation).getByText('16.0')).toBeInTheDocument();
  expect(screen.getByText("Fatigue recorded. Today's load is reduced by 20%.")).toBeInTheDocument();
  expect(screen.getAllByText('16.0').length).toBeGreaterThan(1);
  fireEvent.click(screen.getByRole('button',{name:'Keep recommended load'}));
  expect(within(recommendation).getByText('20.0')).toBeInTheDocument();
  expect(screen.getByRole('slider',{name:/Cookedness/})).toHaveValue('8');
  fireEvent.change(screen.getByRole('slider',{name:/Cookedness/}),{target:{value:'0'}});
  expect(within(recommendation).getByText('20.0')).toBeInTheDocument();
});
