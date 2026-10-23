import React from 'react';
import {render,screen,within} from '@testing-library/react';
import {ContextualTrendResults} from '../ContextualTrendResults.jsx';
test('the model comparison is the accuracy table only; no chart that ignores the model',()=>{
 const score={trainingDays:10,observations:20,mae:2,rmse:3,bias:-1};
 const report={all:{original:score,contextOnly:score,contextRobust:score},byGrip:{},byContext:{}};
 render(<ContextualTrendResults report={report} unit="lbs"/>);
 const table=screen.getByRole('table',{hidden:true});
 for(const name of ['Previous trend','Current trend · earlier training accounted for','Earlier training + unusual-result protection'])
  expect(within(table).getByText(name)).toBeInTheDocument();
 expect(screen.queryByRole('checkbox',{name:'Compare trend charts',hidden:true})).not.toBeInTheDocument();
 expect(screen.queryByLabelText('Research trend model')).not.toBeInTheDocument();
});

test('research shows paired uncertainty, per-model sample sizes, and avoids claiming a winner across zero',()=>{
 const score={trainingDays:12,observations:27,mae:2,rmse:3,bias:-1};
 const scores={original:score,contextOnly:score,contextRobust:score};
 const report={all:scores,byGrip:{Micro:scores},byContext:{},pairedDifferences:{
  contextOnly:{days:12,deltaMae:-0.1,interval95:[-0.5,0.2]},
  contextRobust:{days:12,deltaMae:0.2,interval95:[0.1,0.5]},
 }};
 render(<ContextualTrendResults report={report} unit="kg"/>);
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
  pairedDifferences:{contextOnly:{days:1,deltaMae:-0.2,interval95:null}}}} unit="lbs"/>);
 expect(screen.getAllByText(/More paired training days are needed/)).toHaveLength(2);
 expect(screen.queryByText(/Lower error in this historical comparison/)).not.toBeInTheDocument();
});
