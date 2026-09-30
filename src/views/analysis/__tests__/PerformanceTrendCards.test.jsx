import React from 'react';
import {render,screen,fireEvent} from '@testing-library/react';
import {PerformanceTrendCards} from '../PerformanceTrendCards.jsx';
import {buildPerformanceTrends} from '../../../model/performanceTrends.js';
jest.mock('../../../model/performanceTrends.js',()=>({buildPerformanceTrends:jest.fn(),DEFAULT_PERFORMANCE_TREND_MODEL:'contextOnly'}));
jest.mock('recharts',()=>{
 const React=require('react');const Wrap=({children})=><div>{children}</div>;
 return {ResponsiveContainer:Wrap,ComposedChart:({data,children})=><div data-testid="trend-chart" data-dates={data.map(r=>r.date).join(',')}>{children}</div>,
 Line:()=>null,Bar:()=>null,XAxis:()=>null,YAxis:()=>null,Tooltip:()=>null,CartesianGrid:()=>null,ReferenceLine:()=>null};
});
const history=[],grips=['Micro'];
beforeEach(()=>buildPerformanceTrends.mockReturnValue(Array.from({length:6},(_,i)=>({date:`2026-08-0${i+1}`,timestamp:Date.UTC(2026,7,i+1),Micro_long:i,Micro_short:i-3}))));
test('both charts share the window without refitting, and sliders restore all dates',()=>{
 render(<PerformanceTrendCards history={history} grips={grips}/>);
 expect(screen.getAllByTestId('trend-chart')).toHaveLength(2);
 expect(buildPerformanceTrends).toHaveBeenCalledWith(history,grips,'pooled',{model:'contextOnly'});
 expect(screen.getByText(/Sessions after earlier finger training/)).toBeInTheDocument();
 expect(screen.queryByText(/Research preview/)).not.toBeInTheDocument();
 fireEvent.change(screen.getByRole('slider',{name:'Start date'}),{target:{value:2}});
 fireEvent.change(screen.getByRole('slider',{name:'End date'}),{target:{value:4}});
 screen.getAllByTestId('trend-chart').forEach(chart=>expect(chart).toHaveAttribute('data-dates','2026-08-03,2026-08-04,2026-08-05'));
 expect(buildPerformanceTrends).toHaveBeenCalledTimes(1);
 expect(screen.queryByRole('button',{name:'Show all dates'})).not.toBeInTheDocument();
 expect(screen.queryByRole('checkbox',{name:'Show climbing load'})).not.toBeInTheDocument();
 fireEvent.change(screen.getByRole('slider',{name:'Start date'}),{target:{value:0}});
 fireEvent.change(screen.getByRole('slider',{name:'End date'}),{target:{value:5}});
 expect(screen.getByText('Showing 6 of 6 training dates')).toBeInTheDocument();
});
test('empty history explains why the charts are unavailable',()=>{
 buildPerformanceTrends.mockReturnValue([]);
 render(<PerformanceTrendCards history={history} grips={grips}/>);
 expect(screen.getByText(/More training dates needed/)).toBeInTheDocument();
 expect(screen.queryByRole('slider')).not.toBeInTheDocument();
});


test('deleting dates in a selected window keeps charts and both handles usable',()=>{
 const view=render(<PerformanceTrendCards history={history} grips={grips}/>);
 fireEvent.change(screen.getByRole('slider',{name:'Start date'}),{target:{value:4}});
 const rows=Array.from({length:5},(_,i)=>({date:`2026-08-0${i+1}`,timestamp:Date.UTC(2026,7,i+1),Micro_long:i,Micro_short:i}));
 buildPerformanceTrends.mockReturnValue(rows);
 view.rerender(<PerformanceTrendCards history={[{id:'changed'}]} grips={grips}/>);
 expect(screen.getByText('Showing 2 of 5 training dates')).toBeInTheDocument();
 screen.getAllByTestId('trend-chart').forEach(chart=>expect(chart).toHaveAttribute('data-dates','2026-08-04,2026-08-05'));
 fireEvent.change(screen.getByRole('slider',{name:'Start date'}),{target:{value:0}});
 expect(screen.getByText('Showing 5 of 5 training dates')).toBeInTheDocument();
 expect(screen.getAllByText('▮ Climbing load (0–10)')).toHaveLength(2);
});
