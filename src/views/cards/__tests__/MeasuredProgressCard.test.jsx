import React from 'react';
import {render,screen} from '@testing-library/react';
import {MeasuredProgressSection} from '../MeasuredProgressCard.jsx';
const dates=['2026-07-01','2026-07-08','2026-07-15','2026-08-20','2026-08-27','2026-09-03'];
const history=dates.map((date,i)=>({id:`${i}`,session_id:`s${i}`,date,grip:'Micro',hand:'L',rep_num:1,set_num:1,avg_force_kg:i<3?20:24,peak_force_kg:30,actual_time_s:30,failure_valid:true,load_provenance:'measured_force',force_recording:{version:2,capacity_eligible:true}}));
test('six empty grip/hand combinations produce one explanation',()=>{
 render(<MeasuredProgressSection history={[]} grips={['Micro','Crusher','Prime']} today="2026-09-10" />);
 expect(screen.getAllByText(/Not enough recent, comparable sessions/)).toHaveLength(1);
 expect(screen.queryByText('Micro · Left')).not.toBeInTheDocument();
 expect(screen.queryByText('How comparisons work')).not.toBeInTheDocument();
});
test('available comparisons remain visible and missing ones are summarized once',()=>{
 render(<MeasuredProgressSection history={history} grips={['Micro','Crusher','Prime']} today="2026-09-10" />);
 expect(screen.getByText('Micro · Left')).toBeInTheDocument();
 expect(screen.getByText(/— Improving/)).toBeInTheDocument();
 expect(screen.queryByText('Micro · Right')).not.toBeInTheDocument();
 expect(screen.getAllByText(/Other comparisons need/)).toHaveLength(1);
});
test('selected hand is respected and stale history shows uncertainty',()=>{
 const {rerender}=render(<MeasuredProgressSection history={history} grips={['Micro']} hands={['R']} today="2026-09-10" />);
 expect(screen.queryByText(/— Improving/)).not.toBeInTheDocument();
 rerender(<MeasuredProgressSection history={history} grips={['Micro']} today="2027-01-01" />);
 expect(screen.getAllByText(/Not enough recent, comparable sessions/)).toHaveLength(1);
});
