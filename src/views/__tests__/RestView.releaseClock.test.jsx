import React from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { RestView } from '../ActiveSessionViews.js';
const lastRep = {actualTime:10,avgForce:20,failureValid:true,targetTime:30};
const props = {restSeconds:20,repNum:1,repsPerSet:4,lastRep};
beforeEach(()=>{jest.useFakeTimers();jest.setSystemTime(100000);});
afterEach(()=>jest.useRealTimers());

test('credits the one-second release confirmation and ends at release plus prescribed rest',()=>{
 const done=jest.fn();
 render(<RestView {...props} lastRep={{...lastRep,restStartedAtMs:99000}} onRestDone={done}/>);
 expect(screen.getByText('19s')).toBeInTheDocument();
 act(()=>jest.advanceTimersByTime(18000));
 expect(screen.getByText('1s')).toBeInTheDocument();
 expect(done).not.toHaveBeenCalled();
 act(()=>jest.advanceTimersByTime(1000));
 expect(done).toHaveBeenCalledTimes(1);
});
test('counts render delays and does not reset when the same result is refreshed',()=>{
 const done=jest.fn();
 const result={...lastRep,restStartedAtMs:97000};
 const view=render(<RestView {...props} lastRep={result} onRestDone={done}/>);
 expect(screen.getByText('17s')).toBeInTheDocument();
 act(()=>jest.advanceTimersByTime(5000));
 view.rerender(<RestView {...props} lastRep={{...result}} onRestDone={done}/>);
 expect(screen.getByText('12s')).toBeInTheDocument();
 act(()=>jest.advanceTimersByTime(12000));
 expect(done).toHaveBeenCalledTimes(1);
});
test.each([undefined,null,NaN,110000])('missing or future rest origin %s cannot extend the rest',origin=>{
 render(<RestView {...props} lastRep={{...lastRep,restStartedAtMs:origin}} onRestDone={jest.fn()}/>);
 expect(screen.getByText('20s')).toBeInTheDocument();
});
test('a fully elapsed rest advances once even with StrictMode effect replay',()=>{
 const done=jest.fn();
 render(<React.StrictMode><RestView {...props} lastRep={{...lastRep,restStartedAtMs:70000}} onRestDone={done}/></React.StrictMode>);
 expect(screen.getByText('0s')).toBeInTheDocument();
 expect(done).toHaveBeenCalledTimes(1);
 act(()=>jest.advanceTimersByTime(5000));
 expect(done).toHaveBeenCalledTimes(1);
});


test('unknown release blocks advancement and starts full rest after the unloaded check',()=>{
 const done=jest.fn(),zero=jest.fn();
 const tindeq={connected:true,releaseCheckRequired:true,zeroing:false,zeroForNextRep:zero};
 const view=render(<RestView {...props} tindeq={tindeq} onRestDone={done}/>);
 expect(screen.getByText('Release check')).toBeInTheDocument();
 act(()=>jest.advanceTimersByTime(30000));
 expect(done).not.toHaveBeenCalled();
 const skip=screen.getByRole('button',{name:/skip rest/i});
 expect(skip).toBeDisabled();
 fireEvent.click(skip);
 fireEvent.click(screen.getByRole('button',{name:/handle unloaded/i}));
 expect(zero).toHaveBeenCalledTimes(1);
 view.rerender(<RestView {...props} tindeq={{...tindeq,releaseCheckRequired:false}} onRestDone={done}/>);
 expect(screen.getByText('20s')).toBeInTheDocument();
 act(()=>jest.advanceTimersByTime(19000));
 expect(done).not.toHaveBeenCalled();
 act(()=>jest.advanceTimersByTime(1000));
 expect(done).toHaveBeenCalledTimes(1);
});
