import React from 'react';
import {render,screen,cleanup} from '@testing-library/react';
import {ClimbingAnalysisView} from '../ClimbingAnalysisView.jsx';
import {sessionFatigueDetail} from '../../model/climbingFatigue.js';
import {gradeRank,afaVSum} from '../../lib/climbing-grades.js';
jest.mock('../cards/PyramidChart.jsx',()=>({PyramidChart:()=>null}));
jest.mock('recharts',()=>({
 ResponsiveContainer:({children})=><div>{children}</div>,
 ComposedChart:({data})=><div data-testid="volume-data">{JSON.stringify(data)}</div>,
 LineChart:()=>null,Line:()=>null,Bar:()=>null,XAxis:()=>null,YAxis:()=>null,
 Tooltip:()=>null,CartesianGrid:()=>null,Legend:()=>null,
}));
const climb=(ascent,discipline='boulder',grade='V4')=>({type:'climbing',date:'2026-09-28',ascent,discipline,grade});
test.each(['boulder','lead','top_rope'])('repeat-only %s sessions appear in volume with the same credit as sends',discipline=>{
 const grade=discipline==='boulder'?'V4':'5.12a',key=discipline==='boulder'?'boulder':'route';
 for(const ascent of ['redpoint','repeat']){
  render(<ClimbingAnalysisView activities={[climb(ascent,discipline,grade)]}/>);
  const rows=JSON.parse(screen.getByTestId('volume-data').textContent);
  expect(rows).toHaveLength(1);
  expect(rows[0][key]).toBe(discipline==='boulder'?gradeRank(grade):afaVSum(grade));
  cleanup();
 }
});
test('repeats add to both charts alongside other completions; attempts do not add completed volume',()=>{
 const ascents=['onsight','flash','redpoint','repeat','rest','attempt'];
 const activities=ascents.flatMap(ascent=>[climb(ascent),climb(ascent,'lead','5.12a')]);
 render(<ClimbingAnalysisView activities={activities}/>);
 const [boulder,route]=screen.getAllByTestId('volume-data').map(e=>JSON.parse(e.textContent)[0]);
 expect(boulder.boulder).toBe(5*gradeRank('V4'));
 expect(route.route).toBe(5*afaVSum('5.12a'));
});


test('project attempts increase climbing effort without inventing completed ascents',()=>{
 const easy=[{...climb('redpoint','boulder','V7'),attempts:1,rpe:8}];
 const project=[{...easy[0],attempts:8}];
 render(<ClimbingAnalysisView activities={project}/>);
 expect(screen.getByText('Completed boulder output (v-sum)')).toBeInTheDocument();
 expect(screen.getByText(/Eight attempts ending in one send count as one completion/)).toBeInTheDocument();
 expect(JSON.parse(screen.getByTestId('volume-data').textContent)[0].boulder).toBe(gradeRank('V7'));
 expect(sessionFatigueDetail(project,'2026-09-28').scoreExact).toBeGreaterThan(sessionFatigueDetail(easy,'2026-09-28').scoreExact);
});
