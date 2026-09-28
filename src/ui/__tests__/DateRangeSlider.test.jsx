import React,{useState} from 'react';
import {render,screen,fireEvent} from '@testing-library/react';
import {DateRangeSlider} from '../DateRangeSlider.jsx';
const dates=['2026-08-01','2026-08-03','2026-08-07','2026-08-10'];
function Demo(){const [[start,end],set]=useState([0,3]);return <DateRangeSlider dates={dates} start={start} end={end} onChange={(a,b)=>set([a,b])}/>;}
test('both handles move independently, cannot cross, and expose dates to assistive technology',()=>{
 render(<Demo/>);
 const start=screen.getByRole('slider',{name:'Start date'}),end=screen.getByRole('slider',{name:'End date'});
 fireEvent.change(start,{target:{value:1}});
 expect(start).toHaveAttribute('aria-valuetext','2026-08-03');
 fireEvent.change(end,{target:{value:2}});
 expect(screen.getByText('Showing 2 of 4 training dates')).toBeInTheDocument();
 fireEvent.change(start,{target:{value:3}});
 expect(start).toHaveValue('1');
 fireEvent.change(end,{target:{value:0}});
 expect(end).toHaveValue('2');
 fireEvent.change(screen.getByLabelText('From date'),{target:{value:'2026-08-01'}});
 expect(start).toHaveValue('0');
});
test('one training date disables both handles without invalid range arithmetic',()=>{
 render(<DateRangeSlider dates={dates.slice(0,1)} start={0} end={0} onChange={jest.fn()}/>);
 screen.getAllByRole('slider').forEach(s=>expect(s).toBeDisabled());
});
