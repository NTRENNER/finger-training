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
  // Closed until asked for: no modifier controls on the row.
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Modify set 1'}));
  fireEvent.click(screen.getByRole('menuitem',{name:'Slingshot'}));          // on/off: applies at once
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Change Slingshot on set 1'}));
  fireEvent.change(screen.getByRole('spinbutton',{name:'Slingshot affected reps for set 1'}),{target:{value:'1'}});
  expect(JSON.parse(screen.getByTestId('logged').textContent).sets[0]).toMatchObject({weight:'155',reps:'5',modifiers:{modifier_slingshot:{repCount:1,kind:'assistance'}}});
  fireEvent.click(screen.getByRole('button',{name:'+ Modify'}));
  fireEvent.change(screen.getByRole('textbox',{name:'Custom modifier for set 1'}),{target:{value:'Board press'}});
  fireEvent.click(screen.getByRole('button',{name:'Add modifier'}));
  expect(JSON.parse(screen.getByTestId('logged').textContent).sets[0].modifiers.modifier_custom_board_press.name).toBe('Board press');
});

test('band assistance keeps its multi-band controls after the first selection', () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button',{name:'Modify set 1'}));
  fireEvent.click(screen.getByRole('menuitem',{name:'Band assistance'}));
  fireEvent.click(screen.getByRole('button',{name:'Band assistance for set 1: Green'}));
  fireEvent.click(screen.getByRole('button',{name:'Band assistance for set 1: Blue'}));
  expect(JSON.parse(screen.getByTestId('logged').textContent).sets[0].modifiers.modifier_band_assistance.value).toBe('green+blue');
});

function TwoSets() {
  const [data,setData] = useState({sets:[{weight:'155',reps:'5',done:false},{weight:'155',reps:'5',done:false}]});
  return <><SessionExRow ex={{id:'benchPress',name:'Bench Press',reps:'5',logWeight:true}} unit="lbs"
    setsData={data} onSetsChange={change => setData(old=>({...old,...change}))} last />
    <output data-testid="logged">{JSON.stringify(data)}</output></>;
}
test('each set keeps its own custom-modifier draft, and custom ids are stable and clean', () => {
  render(<TwoSets />);
  fireEvent.click(screen.getByText('Modify set 1'));
  fireEvent.click(screen.getByText('Modify set 2'));
  fireEvent.change(screen.getByRole('textbox',{name:'Custom modifier for set 1'}),{target:{value:'  Board press!! '}});
  expect(screen.getByRole('textbox',{name:'Custom modifier for set 2'})).toHaveValue('');
  const addButtons = screen.getAllByRole('button',{name:'Add modifier'});
  expect(addButtons[1]).toBeDisabled();
  fireEvent.click(addButtons[0]);
  const sets = JSON.parse(screen.getByTestId('logged').textContent).sets;
  expect(Object.keys(sets[0].modifiers)).toEqual(['modifier_custom_board_press']);
  expect(sets[1].modifiers).toBeUndefined();
});

// Changing a set's setup clears its typed weight; the recommended weight
// for the new setup is then shown, and must be what the completed set saves.
test('a set completed after a setup change saves the weight it showed', () => {
  const band = { id: 'modifier_band', name: 'Band', kind: 'assistance', control: 'standard', options: [{ id: 'red', label: 'Red' }] };
  function Banded() {
    const [data,setData] = useState({sets:[{weight:'155',reps:'5',done:false}]});
    const banded = !!data.sets[0].modifiers?.modifier_band;
    return <><SessionExRow ex={{id:'pullup',name:'Pull-up',reps:'5',logWeight:true,setupModifiers:[band]}} unit="lbs"
      setsData={data} onSetsChange={change => setData(old=>({...old,...change}))}
      recommendations={[{weight: banded ? '20' : '155', reps:'5'}]} last />
      <output data-testid="logged">{JSON.stringify(data)}</output></>;
  }
  render(<Banded />);
  fireEvent.click(screen.getByRole('button',{name:'Modify set 1'}));
  fireEvent.click(screen.getByRole('menuitem',{name:'Band'}));
  fireEvent.change(screen.getByRole('combobox',{name:'Band for set 1'}),{target:{value:'red'}});
  expect(JSON.parse(screen.getByTestId('logged').textContent).sets[0].weight).toBe('');
  expect(screen.getByDisplayValue('20')).toBeInTheDocument();
  fireEvent.click(screen.getByTitle('Set 1: tap to toggle done'));
  expect(JSON.parse(screen.getByTestId('logged').textContent).sets[0]).toMatchObject({weight:'20',reps:'5',done:true});
});

// The menu lists one entry per modifier with a single band picker; a
// custom modifier is handed up to join the list, and ✕ deletes an entry.
test('the Modify menu lists each modifier once and can grow or shrink the list', () => {
  const band = { id: 'modifier_band_mglzk', name: 'Band', kind: 'setup', control: 'bands', options: [{ id: 'red', label: 'Red' }] };
  const onCreate = jest.fn(), onDelete = jest.fn();
  function Row() {
    const [data,setData] = useState({sets:[{reps:'1',seconds:'10',variant:'Full',done:false}]});
    return <SessionExRow ex={{id:'frontLever',name:'Front Lever',reps:'1',logTime:true,logVariant:true,
      variants:['Full'],logWeight:false,setupModifiers:[band]}} unit="lbs" setsData={data}
      onSetsChange={change => setData(old=>({...old,...change}))}
      onCreateModifier={onCreate} onDeleteModifier={onDelete} last />;
  }
  render(<Row />);
  // A bodyweight hold has no weight box.
  expect(screen.queryByText('weight')).not.toBeInTheDocument();
  expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Modify set 1'}));
  const items = screen.getAllByRole('menuitem').map(item => item.textContent);
  expect(items.filter(name => /band/i.test(name))).toEqual(['Band']);
  expect(new Set(items).size).toBe(items.length);
  fireEvent.click(screen.getByRole('button',{name:'Delete Tempo from the modifier list'}));
  expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'modifier_tempo' }));
  fireEvent.change(screen.getByRole('textbox',{name:'Custom modifier for set 1'}),{target:{value:'Rings'}});
  fireEvent.click(screen.getByRole('button',{name:'Add modifier'}));
  expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ id: 'modifier_custom_rings', name: 'Rings' }));
  expect(screen.getByRole('button',{name:'Change Rings on set 1'})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Remove Rings from set 1'}));
  expect(screen.queryByRole('button',{name:'Change Rings on set 1'})).not.toBeInTheDocument();
});
