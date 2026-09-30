import React,{useState} from 'react';
import {render,screen,fireEvent} from '@testing-library/react';
import {DateRangeSlider,normalizeHistoryWindow} from '../DateRangeSlider.jsx';
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
 expect(screen.getByText('2026-08-03')).toHaveAttribute('datetime','2026-08-03');
 expect(screen.getByText('2026-08-07')).toHaveAttribute('datetime','2026-08-07');
 expect(document.querySelector('input[type="date"]')).toBeNull();
});
test('one training date disables both handles without invalid range arithmetic',()=>{
 render(<DateRangeSlider dates={dates.slice(0,1)} start={0} end={0} onChange={jest.fn()}/>);
 screen.getAllByRole('slider').forEach(s=>expect(s).toBeDisabled());
});


test('a collapsed or out-of-bounds window recovers to neighboring available dates',()=>{
 expect(normalizeHistoryWindow(3,3,3)).toEqual([2,3]);
 expect(normalizeHistoryWindow(20,30,3)).toEqual([2,3]);
 expect(normalizeHistoryWindow(0,-1,3)).toEqual([0,1]);
 const view=render(<DateRangeSlider dates={dates} start={3} end={3} onChange={jest.fn()}/>);
 expect(screen.getByText('Showing 2 of 4 training dates')).toBeInTheDocument();
 expect(screen.getByRole('slider',{name:'Start date'})).toHaveValue('2');
 view.rerender(<DateRangeSlider dates={dates.slice(0,1)} start={3} end={3} onChange={jest.fn()}/>);
 expect(screen.getByText('Showing 1 of 1 training dates')).toBeInTheDocument();
});

test('overlapping touch targets allow dragging either handle and keep keyboard focus',()=>{
 const OriginalPointerEvent=window.PointerEvent;
 window.PointerEvent=class extends MouseEvent { constructor(type,options){super(type,options);this.pointerId=options.pointerId;} };
 function Dense(){const [[a,b],set]=useState([40,41]);return <DateRangeSlider dates={Array.from({length:101},(_,i)=>String(i))}
  start={a} end={b} onChange={(x,y)=>set([x,y])}/>;}
 try {
  const {container}=render(<Dense/>);
  const surface=container.querySelector('.history-slider');
  surface.getBoundingClientRect=()=>({left:0,width:240});
  surface.setPointerCapture=jest.fn();
  const start=screen.getByRole('slider',{name:'Start date'}),end=screen.getByRole('slider',{name:'End date'});
  // Centers are only 2px apart, while native thumb targets are 40px wide.
  fireEvent.pointerDown(surface,{clientX:99,button:0,pointerId:1});
  fireEvent.pointerMove(surface,{clientX:60,pointerId:1});
  fireEvent.pointerUp(surface,{clientX:60,pointerId:1});
  expect(start).toHaveValue('20');
  expect(end).toHaveValue('41');
  expect(start).toHaveFocus();
  fireEvent.pointerDown(surface,{clientX:102,button:0,pointerId:2});
  fireEvent.pointerMove(surface,{clientX:200,pointerId:2});
  fireEvent.pointerCancel(surface,{pointerId:2});
  expect(end).toHaveValue('90');
  expect(end).toHaveFocus();
  fireEvent.pointerMove(surface,{clientX:220,pointerId:2});
  expect(end).toHaveValue('90');
  fireEvent.change(start,{target:{value:10}});
  expect(start).toHaveValue('10');
 } finally {window.PointerEvent=OriginalPointerEvent;}
});
