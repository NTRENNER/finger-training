import React from 'react';
import {render,screen,fireEvent,within} from '@testing-library/react';
import {ContextualTrendResults} from '../ContextualTrendResults.jsx';
import {PerformanceTrendCards} from '../../analysis/PerformanceTrendCards.jsx';
jest.mock('../../analysis/PerformanceTrendCards.jsx',()=>({PerformanceTrendCards:jest.fn(()=> <div>Trend preview</div>)}));
test('research previews stay opt-in, switch candidates, and do not replace the default model',()=>{
 const score={trainingDays:10,observations:20,mae:2,rmse:3,bias:-1};
 const report={all:{original:score,contextOnly:score,contextRobust:score},byGrip:{},byContext:{}};
 const history=[{grip:'Micro'},{grip:'Crusher'}];
 render(<ContextualTrendResults report={report} history={history} unit="lbs"/>);
 expect(PerformanceTrendCards).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('checkbox',{name:'Compare trend charts',hidden:true}));
 expect(PerformanceTrendCards.mock.calls.at(-1)[0]).toMatchObject({history,grips:['Micro','Crusher'],trendModel:'contextOnly'});
 fireEvent.change(screen.getByLabelText('Research trend model'),{target:{value:'contextRobust'}});
 expect(PerformanceTrendCards.mock.calls.at(-1)[0].trendModel).toBe('contextRobust');
 fireEvent.change(screen.getByLabelText('Research trend model'),{target:{value:'original'}});
 expect(PerformanceTrendCards.mock.calls.at(-1)[0].trendModel).toBe('original');
});


test('research shows paired uncertainty, per-model sample sizes, and avoids claiming a winner across zero',()=>{
 const score={trainingDays:12,observations:27,mae:2,rmse:3,bias:-1};
 const scores={original:score,contextOnly:score,contextRobust:score};
 const report={all:scores,byGrip:{Micro:scores},byContext:{},pairedDifferences:{
  contextOnly:{days:12,deltaMae:-0.1,interval95:[-0.5,0.2]},
  contextRobust:{days:12,deltaMae:0.2,interval95:[0.1,0.5]},
 }};
 render(<ContextualTrendResults report={report} history={[]} unit="kg"/>);
 expect(screen.getByText('95% uncertainty range: -0.50 kg to 0.20 kg')).toBeInTheDocument();
 expect(screen.getByText(/range includes zero/)).toBeInTheDocument();
 expect(screen.getByText('Higher error in this historical comparison.')).toBeInTheDocument();
 const tables=screen.getAllByRole('table',{hidden:true});
 expect(tables).toHaveLength(2);
 for(const table of tables){
  expect(within(table).getByText('Training days')).toBeInTheDocument();
  expect(within(table).getAllByText('12')).toHaveLength(3);
  expect(within(table).getAllByText('27')).toHaveLength(3);
 }
});

test('too little paired history reports uncertainty as unavailable',()=>{
 const score={trainingDays:1,observations:2};
 render(<ContextualTrendResults report={{all:{original:score},byGrip:{},byContext:{},
  pairedDifferences:{contextOnly:{days:1,deltaMae:-0.2,interval95:null}}}} history={[]} unit="lbs"/>);
 expect(screen.getAllByText(/More paired training days are needed/)).toHaveLength(2);
 expect(screen.queryByText(/Lower error in this historical comparison/)).not.toBeInTheDocument();
});
