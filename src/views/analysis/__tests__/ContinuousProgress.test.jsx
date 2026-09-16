import React from 'react';
import {render,screen,fireEvent} from '@testing-library/react';
import {CurveImprovementCard} from '../CurveImprovementCard.jsx';
import {useContinuousProgress} from '../../../hooks/useContinuousProgress.js';
beforeAll(()=>{global.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};});
afterAll(()=>{delete global.ResizeObserver;});
const old=Array.from({length:12},(_,i)=>({id:String(i),session_id:String(i),date:`2020-07-${10+i}`,grip:'Micro',hand:'L',rep_num:1,set_num:1,avg_force_kg:[35,25,18,12][i%4]*(1+i*.01),peak_force_kg:40,actual_time_s:[5,30,90,240][i%4],target_duration:[5,30,90,240][i%4]}));
const newer={...old[0],id:'new',session_id:'new',date:'2020-08-01',actual_time_s:45,avg_force_kg:25,force_recording:{basis:'target_acquired',acquisition_s:1}};
function Harness({history,handView='pooled',normalizeOn=false}) {
 const progress=useContinuousProgress({history,grips:['Micro']});
 return <CurveImprovementCard {...progress} history={history} comparisonHistory={progress.displayHistory} selGrip="Micro" grips={['Micro']} unit="kg" handView={handView} normalizeOn={normalizeOn} bodyWeight={70}/>;
}

// The requirement: a session recorded on the new basis must not cost the grip
// its six-domain card. It used to, because the earlier reps were discarded;
// now they are converted onto one interval and simply stay. The card survives
// because the history does — so unlike the chained version this asserts the
// new session is INCORPORATED, rather than that the old numbers are frozen.
test('a new-method session keeps the six domain card, modes and slider',()=>{
 const view=render(<Harness history={old}/>);
 const before=screen.getAllByText(/^[+-][0-9]+%$/).map(el=>el.textContent);
 expect(before.length).toBeGreaterThanOrEqual(6);

 view.rerender(<Harness history={[...old,newer]}/>);
 expect(screen.getAllByText(/^[+-][0-9]+%$/).length).toBe(before.length);
 expect(screen.queryByText(/building baseline/)).not.toBeInTheDocument();

 // The new session is a real slider stop on the same continuous series.
 const slider=screen.getByRole('slider',{name:'Micro comparison date'});
 expect(Number(slider.max)).toBeGreaterThan(0);
 fireEvent.change(slider,{target:{value:'0'}});
 expect(screen.getAllByText(/^[+-][0-9]+%$/).length).toBeGreaterThanOrEqual(6);
 fireEvent.change(slider,{target:{value:slider.max}});

 fireEvent.click(screen.getByRole('button',{name:'Weight',exact:true}));
 expect(screen.getAllByRole('button',{name:/weight progress$/})).toHaveLength(6);
 fireEvent.click(screen.getByRole('button',{name:'Time',exact:true}));
 expect(screen.getAllByRole('button',{name:/hold time$/})).toHaveLength(6);

 view.rerender(<Harness history={[...old,newer]} handView="L"/>);
 expect(screen.getByRole('slider',{name:'Micro comparison date'})).toBeInTheDocument();
});
