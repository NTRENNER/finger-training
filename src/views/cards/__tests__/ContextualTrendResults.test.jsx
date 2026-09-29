import React from 'react';
import {render,screen,fireEvent} from '@testing-library/react';
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
