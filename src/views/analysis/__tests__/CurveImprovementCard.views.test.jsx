import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CurveImprovementCard } from "../CurveImprovementCard.jsx";

beforeAll(() => { global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; });
afterAll(() => { delete global.ResizeObserver; });
const baseline = { amps: [0, 0, 50], date: "2026-06-01", maxHoldS: 240 };
const branch = {
  baselineAmps: baseline.amps, baselineDate: baseline.date, baselineMaxHoldS: 240,
  dates: ["2026-06-01", "2026-07-01"],
  ampsByDate: new Map([["2026-06-01", baseline.amps], ["2026-07-01", [0, 0, 60]]]),
  maxHoldByDate: new Map([["2026-06-01", 240], ["2026-07-01", 240]]),
};
const history = [{ id: "baseline-pull", grip: "Crusher", hand: "L", date: baseline.date, rep_num: 1, set_num: 1, avg_force_kg: 45, peak_force_kg: 50, actual_time_s: 50, target_duration: 30 }];
const props = {
  improvement: {}, gripImprovement: { Crusher: {} }, grip3xEstimates: { Crusher: [0, 0, 60] },
  gripBaselines: { Crusher: baseline }, selGrip: "Crusher", history,
  historyOverlay: { Crusher: { ...branch, perHand: { L: branch } } }, unit: "kg",
  perHandGripImprovement: { "Crusher|L": {} }, perHandGripBaselines: { "Crusher|L": baseline },
  perHandGripEstimates: { "Crusher|L": [0, 0, 60] },
};
const choose = name => fireEvent.click(screen.getByRole("button", { name, exact: true }));

test("percentage stays default; weight shows pounds or kilograms at the same domain duration", () => {
  const view = render(<CurveImprovementCard {...props} />);
  expect(screen.getByRole("button", { name: "%", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getAllByText("+20%")).toHaveLength(7);
  choose("Weight");
  const tile = screen.getByRole("button", { name: "Power weight progress" });
  expect(tile).toHaveTextContent("+9.4 kg");
  expect(tile).toHaveTextContent("47.0 → 56.4 kg");
  expect(tile).toHaveTextContent("at 30s");
  expect(screen.queryByText("total")).not.toBeInTheDocument();
  view.rerender(<CurveImprovementCard {...props} unit="lbs" />);
  expect(tile).toHaveTextContent("+20.7 lbs");
  fireEvent.click(tile);
  fireEvent.click(screen.getByRole("button", { name: "View Power sessions" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("Power history");
});

test("fixed weight survives scrubbing, view changes, and added workouts", () => {
  const view = render(<CurveImprovementCard {...props} />);
  choose("Time");
  expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Hold time comparison")).toHaveTextContent("50.6 → 138.1 seconds at 45.0 kg");
  fireEvent.change(screen.getByRole("slider"), { target: { value: "0" } });
  expect(screen.getByText("Power · comparing at 45.0 kg")).toBeInTheDocument();
  expect(screen.getByLabelText("Hold time comparison")).toHaveTextContent("+0.0s");
  choose("Weight"); choose("Time");
  expect(screen.getByText("Power · comparing at 45.0 kg")).toBeInTheDocument();
  view.rerender(<CurveImprovementCard {...props} history={[...history, { ...history[0], id: "later", date: "2026-08-01", avg_force_kg: 48 }]} />);
  expect(screen.getByText("Power · comparing at 45.0 kg")).toBeInTheDocument();
});

test("bodyweight scaling never changes the fixed physical load", () => {
  const view = render(<CurveImprovementCard {...props} normalizeOn bodyWeight={60}
    bwLog={[{ date: baseline.date, kg: 50 }, { date: "2026-07-01", kg: 60 }]} />);
  expect(screen.getAllByText("+0%")).toHaveLength(7);
  choose("Weight");
  expect(screen.getByRole("button", { name: "Power weight progress" })).toHaveTextContent("+9.4 kg");
  choose("Time");
  expect(screen.getByText("Power · comparing at 45.0 kg")).toBeInTheDocument();
  expect(screen.getByLabelText("Hold time comparison")).toHaveTextContent("50.6 → 138.1");
  view.rerender(<CurveImprovementCard {...props} unit="lbs" normalizeOn bodyWeight={70} />);
  expect(screen.getByText("Power · comparing at 99.2 lbs")).toBeInTheDocument();
  expect(screen.getByLabelText("Hold time comparison")).toHaveTextContent("50.6 → 138.1");
});

test("hold-time evidence respects hand and selected date, excluding interruptions", () => {
  render(<CurveImprovementCard {...props} handView="L" history={[
    ...history,
    { ...history[0], id: "right", hand: "R", actual_time_s: 90 },
    { ...history[0], id: "interrupted", date: "2026-06-02", failure_valid: false, actual_time_s: 5 },
    { ...history[0], id: "future", date: "2026-08-01", actual_time_s: 100 },
  ]} />);
  choose("Time");
  const summary = screen.getByText("Recorded pulls at this weight (1)");
  expect(within(summary.parentElement).getByRole("list", { hidden: true })).toHaveTextContent("2026-06-01 · L · 50.0s");
});

test("hold-time weights are independent for each domain", () => {
  render(<CurveImprovementCard {...props} />); choose("Time");
  fireEvent.click(screen.getByRole("button", { name: "Strength hold time" }));
  expect(screen.queryByText("Power · comparing at 45.0 kg")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Power hold time" }));
  expect(screen.getByText("Power · comparing at 45.0 kg")).toBeInTheDocument();
});


test("six hold-time boxes replace the dropdown and update the selected comparison", () => {
  render(<CurveImprovementCard {...props} />); choose("Time");
  const boxes = within(screen.getByRole("group", { name: "Hold time domains" }));
  expect(boxes.getAllByRole("button")).toHaveLength(6);
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  const power = boxes.getByRole("button", { name: "Power hold time" });
  expect(power).toHaveAttribute("aria-pressed", "true");
  expect(power).toHaveTextContent("+87.5s");
  expect(power).toHaveTextContent("at 45.0 kg");
  const previous = screen.getByLabelText("Hold time comparison").textContent;
  const strength = boxes.getByRole("button", { name: "Strength hold time" });
  fireEvent.click(strength);
  expect(strength).toHaveAttribute("aria-pressed", "true");
  expect(power).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByLabelText("Hold time comparison").textContent).not.toBe(previous);
});

test("unsupported hold-time boxes remain selectable and show a dash instead of a gain", () => {
  render(<CurveImprovementCard {...props} />); choose("Time");
  const endurance = screen.getByRole("button", { name: "Endurance hold time" });
  expect(endurance).toHaveTextContent("—");
  fireEvent.click(endurance);
  expect(endurance).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("status")).toHaveTextContent("Not enough supported hold-time data");
  expect(screen.queryByLabelText("Hold time comparison")).not.toBeInTheDocument();
});


test("weight tiles select a dated weight chart without opening a modal", () => {
  render(<CurveImprovementCard {...props} />); choose("Weight");
  const strength = screen.getByRole("button", { name: "Strength weight progress" });
  fireEvent.click(strength);
  expect(strength).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Strength weight over time")).toBeInTheDocument();
  expect(screen.getByLabelText("Weight progress comparison")).toHaveTextContent("at 115 seconds");
  fireEvent.change(screen.getByRole("slider"), { target: { value: "0" } });
  expect(screen.getByLabelText("Weight progress comparison")).toHaveTextContent("+0.0 kg");
  expect(screen.getByLabelText("Weight progress comparison")).toHaveTextContent("2026-06-01 → 2026-06-01");
});

test('a replacement baseline does not erase the historical Micro curve', () => {
  const old=Array.from({length:6},(_,i)=>({id:String(i),session_id:String(i),date:`2026-07-${10+i}`,grip:'Micro',hand:'L',rep_num:1,set_num:1,avg_force_kg:30-i,peak_force_kg:32-i,actual_time_s:10+i*20}));
  const newer={...old[0],id:'new',session_id:'new',date:'2026-09-15',force_recording:{basis:'target_acquired'}};
  const view=render(<CurveImprovementCard grips={['Micro']} selGrip="Micro" history={[...old,newer]} unit="kg"/>);
  expect(screen.getByRole('region',{name:'Micro historical curve'})).toHaveTextContent('1 new session');
  expect(screen.getByText(/90% session-bootstrap interval/)).toBeInTheDocument();
  view.rerender(<CurveImprovementCard grips={['Micro']} selGrip="Micro" history={[...old,newer]} unit="kg" handView="L"/>);
  expect(screen.getByRole('region',{name:'Micro historical curve'})).toBeInTheDocument();
  view.rerender(<CurveImprovementCard grips={['Micro']} selGrip="Micro" history={[...old,newer]} unit="kg" handView="R"/>);
  expect(screen.queryByRole('region',{name:'Micro historical curve'})).not.toBeInTheDocument();
});

test('historical slider restores an earlier evidence view and remains available before the first fit',()=>{
 const old=Array.from({length:6},(_,i)=>({id:String(i),session_id:String(i),date:`2020-07-${10+i}`,grip:'Micro',hand:'L',rep_num:1,set_num:1,avg_force_kg:30-i,peak_force_kg:32-i,actual_time_s:10+i*20}));
 render(<CurveImprovementCard grips={['Micro']} selGrip="Micro" history={old} unit="kg"/>);
 const slider=screen.getByRole('slider',{name:'Micro historical curve date'});
 expect(screen.getByText(/Stale at this date/)).toBeInTheDocument();
 fireEvent.change(slider,{target:{value:'4'}});
 expect(screen.getByText(/5 independent sessions/)).toBeInTheDocument();
 expect(screen.queryByText(/Stale at this date/)).not.toBeInTheDocument();
 fireEvent.change(slider,{target:{value:'0'}});
 expect(screen.getByText(/Not enough evidence to fit a curve at this date/)).toBeInTheDocument();
 expect(slider).toBeInTheDocument();
 fireEvent.change(slider,{target:{value:slider.max}});
 expect(screen.getByText(/6 independent sessions/)).toBeInTheDocument();
});
