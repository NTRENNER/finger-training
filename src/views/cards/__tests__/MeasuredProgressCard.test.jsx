import React from 'react';
import {render,screen} from '@testing-library/react';
import {MeasuredProgressCard} from '../MeasuredProgressCard.jsx';
test('empty history states uncertainty instead of improvement and keeps hands explicit',()=>{
 render(<MeasuredProgressCard history={[]} grip="Micro" hand="L" today="2026-09-10" />);
 expect(screen.getByText('Measured progress · Micro · Left')).toBeInTheDocument();
 expect(screen.getAllByText(/Not enough comparable evidence/)).toHaveLength(3);
 expect(screen.queryByText(/— Improving/)).not.toBeInTheDocument();
});
