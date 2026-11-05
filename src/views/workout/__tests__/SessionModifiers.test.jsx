import React, { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SessionExRow } from '../SessionExRow.jsx';
import { BAND_MODIFIER_OPTIONS, setModifierSelection } from '../../../model/workoutModifiers.js';
import { exercises } from '../../../model/supportTraining.js';

test('selected front-lever bands use the lat-pull color toggles directly and preserve modifier scope',()=>{
  const band={id:'modifier_band',name:'Band',kind:'assistance',control:'bands',options:BAND_MODIFIER_OPTIONS};
  const initial=setModifierSelection({variant:'Full',reps:'4',seconds:'10',done:false},band,['red']);
  initial.modifiers.modifier_band.repCount=2;
  initial.modifiers.modifier_band.side='L';
  function Row(){
    const [data,setData]=useState({sets:[initial]});
    return <><SessionExRow ex={{...exercises.frontLever,setupModifiers:[band],unilateral:true}} unit="lbs"
      setsData={data} onSetsChange={change=>setData(old=>({...old,...change}))} last />
      <output data-testid="band-state">{JSON.stringify(data)}</output></>;
  }
  render(<Row />);
  // No edit/menu tap is needed for a saved band's seven-color picker.
  const picker=screen.getByRole('group',{name:'Band for set 1'});
  expect(within(picker).getAllByRole('button')).toHaveLength(7);
  expect(within(picker).getByRole('button',{name:'Band for set 1: Red'})).toHaveAttribute('aria-pressed','true');
  fireEvent.click(within(picker).getByRole('button',{name:'Band for set 1: Green'}));
  let set=JSON.parse(screen.getByTestId('band-state').textContent).sets[0];
  expect(set).toMatchObject({variant:'Full',reps:'4',seconds:'10',modifiers:{modifier_band:{value:'red+green',repCount:2,side:'L',kind:'assistance'}}});
  expect(set.band).toBeUndefined();
  expect(set.weight).toBeUndefined();
  fireEvent.click(screen.getByRole('button',{name:'Done'}));
  expect(screen.getByRole('group',{name:'Band for set 1'})).toBeVisible();
  expect(screen.queryByRole('spinbutton',{name:'Band affected reps for set 1'})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Band for set 1: Red'}));
  fireEvent.click(screen.getByRole('button',{name:'Band for set 1: Green'}));
  set=JSON.parse(screen.getByTestId('band-state').textContent).sets[0];
  expect(set.modifiers).toEqual({});
  expect(within(screen.getByRole('group',{name:'Band for set 1'})).getAllByRole('button').every(button=>button.getAttribute('aria-pressed')==='false')).toBe(true);
});

test('modifier and lat-pull band selectors share colors, selected state and toggle interaction',()=>{
  const band={id:'modifier_band',name:'Band',kind:'setup',control:'bands',options:BAND_MODIFIER_OPTIONS};
  const selected=setModifierSelection({reps:'1',seconds:'10',variant:'Full'},band,['red']);
  function Rows(){
    const [lever,setLever]=useState({sets:[selected]});
    const [pull,setPull]=useState({sets:[{leftReps:'6',rightReps:'6',leftBand:['red'],rightBand:[]}]});
    return <><SessionExRow ex={{...exercises.frontLever,setupModifiers:[band]}} unit="lbs" setsData={lever} onSetsChange={setLever} last />
      <SessionExRow ex={exercises.bandedLatPull} unit="lbs" setsData={pull} onSetsChange={setPull} last /></>;
  }
  render(<Rows />);
  const modifier=screen.getByRole('group',{name:'Band for set 1'});
  const pull=screen.getByRole('group',{name:/Heavy-Band Single-Arm Lat Pull.*L.*bands/});
  const buttons=group=>within(group).getAllByRole('button');
  expect(buttons(modifier).map(button=>[button.style.cssText,button.getAttribute('aria-pressed')]))
    .toEqual(buttons(pull).map(button=>[button.style.cssText,button.getAttribute('aria-pressed')]));
  fireEvent.click(buttons(modifier)[3]);
  fireEvent.click(buttons(pull)[3]);
  expect(buttons(modifier).map(button=>button.getAttribute('aria-pressed')))
    .toEqual(buttons(pull).map(button=>button.getAttribute('aria-pressed')));
});
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
