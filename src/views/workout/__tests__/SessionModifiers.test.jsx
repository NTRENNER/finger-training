import React, { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionExRow } from '../SessionExRow.jsx';
function Harness() {
  const [data,setData] = useState({sets:[{weight:'155',reps:'5',done:true}]});
  return <><SessionExRow ex={{id:'benchPress',name:'Bench Press',reps:'5',logWeight:true}} unit="lbs"
    setsData={data} onSetsChange={change => setData(old=>({...old,...change}))} last />
    <output data-testid="logged">{JSON.stringify(data)}</output></>;
}
test('a bench set offers assistance without a configured exercise modifier and records one assisted rep', () => {
  render(<Harness />);
  fireEvent.click(screen.getByText('Modify set 1'));
  fireEvent.change(screen.getByRole('combobox',{name:'Slingshot for set 1'}),{target:{value:'on'}});
  fireEvent.change(screen.getByRole('spinbutton',{name:'Slingshot affected reps for set 1'}),{target:{value:'1'}});
  expect(JSON.parse(screen.getByTestId('logged').textContent).sets[0]).toMatchObject({weight:'155',reps:'5',modifiers:{modifier_slingshot:{repCount:1,kind:'assistance'}}});
  fireEvent.change(screen.getByRole('textbox',{name:'Custom modifier for set 1'}),{target:{value:'Board press'}});
  fireEvent.click(screen.getByRole('button',{name:'Add modifier'}));
  expect(JSON.parse(screen.getByTestId('logged').textContent).sets[0].modifiers.modifier_custom_board_press.name).toBe('Board press');
});

test('band assistance keeps its multi-band controls after the first selection', () => {
  render(<Harness />);
  fireEvent.click(screen.getByText('Modify set 1'));
  fireEvent.click(screen.getByRole('button',{name:'Band assistance for set 1: Green'}));
  fireEvent.click(screen.getByRole('button',{name:'Band assistance for set 1: Blue'}));
  expect(JSON.parse(screen.getByTestId('logged').textContent).sets[0].modifiers.modifier_band_assistance.value).toBe('green+blue');
});
