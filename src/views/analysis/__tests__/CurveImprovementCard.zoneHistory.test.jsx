import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { CurveImprovementCard } from "../CurveImprovementCard.jsx";

// recharts' ResponsiveContainer (the hand-view overlay chart) needs
// ResizeObserver, which jsdom doesn't ship. Same stub as PeakForceCard.
beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterAll(() => {
  delete global.ResizeObserver;
});

const improvement = {
  total: 12,
  max_strength: 10,
  power: 11,
  power_strength: 12,
  strength: 13,
  strength_endurance: 14,
  endurance: 15,
};

const rep = (target, actual, load, over = {}) => ({
  session_id: "session",
  date: "2026-07-24",
  grip: "Crusher",
  hand: "L",
  set_num: 1,
  rep_num: 1,
  target_duration: target,
  actual_time_s: actual,
  avg_force_kg: load,
  ...over,
});

test("opens the selected zone's session history from a global tile", () => {
  render(
    <CurveImprovementCard
      improvement={improvement}
      gripImprovement={{}}
      grip3xEstimates={{ Crusher: [1, 1, 1] }}
      gripBaselines={{}}
      global3xBaseline={{ date: "2026-04-20", maxHoldS: 240 }}
      selGrip={null}
      history={[rep(220, 230, 11)]}
      unit="kg"
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Endurance session history" }));

  expect(screen.getByRole("dialog")).toHaveTextContent("Endurance history");
  expect(screen.getByText("230 / 220s")).toBeInTheDocument();
});

test("uses the active hand when opening a per-hand tile", () => {
  render(
    <CurveImprovementCard
      improvement={improvement}
      gripImprovement={{ Crusher: improvement }}
      grip3xEstimates={{ Crusher: [1, 1, 1] }}
      gripBaselines={{}}
      global3xBaseline={null}
      selGrip={null}
      history={[
        rep(160, 170, 10),
        rep(160, 175, 20, { hand: "R" }),
      ]}
      handView="L"
      perHandGripImprovement={{ "Crusher|L": improvement }}
      perHandGripEstimates={{}}
      unit="kg"
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Strength-Endurance session history" }));

  expect(screen.getByText("Crusher · Left hand")).toBeInTheDocument();
  expect(screen.getByText("10.0 kg")).toBeInTheDocument();
  expect(screen.queryByText("20.0 kg")).not.toBeInTheDocument();
});

test("hand view renders the curve + Now slider when the hand has overlay data", () => {
  const branch = () => ({
    baselineAmps: [10, 10, 10],
    baselineDate: "2026-06-01",
    baselineMaxHoldS: 240,
    dates: ["2026-06-08", "2026-07-01"],
    ampsByDate: new Map([
      ["2026-06-08", [10, 10, 10]],
      ["2026-07-01", [12, 12, 12]],
    ]),
    maxHoldByDate: new Map([
      ["2026-06-08", 200],
      ["2026-07-01", 240],
    ]),
  });
  render(
    <CurveImprovementCard
      improvement={improvement}
      gripImprovement={{ Crusher: improvement }}
      grip3xEstimates={{ Crusher: [1, 1, 1] }}
      gripBaselines={{}}
      global3xBaseline={null}
      selGrip={null}
      history={[rep(160, 170, 10)]}
      historyOverlay={{ Crusher: { ...branch(), perHand: { L: branch() } } }}
      handView="L"
      perHandGripImprovement={{ "Crusher|L": improvement }}
      perHandGripEstimates={{}}
      unit="kg"
    />
  );

  // Interactive block: slider present, defaulting to the latest date.
  const slider = screen.getByRole("slider");
  expect(screen.getByText(/2 of 2 sessions since baseline/)).toBeInTheDocument();
  expect(screen.getByText("2026-07-01")).toBeInTheDocument();

  // Scrub back to the first post-baseline session.
  fireEvent.change(slider, { target: { value: "0" } });
  expect(screen.getByText(/1 of 2 sessions since baseline/)).toBeInTheDocument();
  expect(screen.getByText("2026-06-08")).toBeInTheDocument();
});

test("hand view falls back to static tiles when the hand has no overlay", () => {
  render(
    <CurveImprovementCard
      improvement={improvement}
      gripImprovement={{ Crusher: improvement }}
      grip3xEstimates={{ Crusher: [1, 1, 1] }}
      gripBaselines={{}}
      global3xBaseline={null}
      selGrip={null}
      history={[rep(160, 170, 10)]}
      historyOverlay={{}}
      handView="L"
      perHandGripImprovement={{ "Crusher|L": improvement }}
      perHandGripEstimates={{}}
      unit="kg"
    />
  );

  expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  // total 12 and power_strength 12 both render "+12%" — static tiles up.
  expect(screen.getAllByText("+12%").length).toBeGreaterThan(0);
});

test("focused grip also scopes the per-hand improvement view", () => {
  render(
    <CurveImprovementCard
      improvement={improvement}
      gripImprovement={{ Crusher: improvement, Micro: improvement }}
      grip3xEstimates={{ Crusher: [1, 1, 1], Micro: [1, 1, 1] }}
      gripBaselines={{}}
      global3xBaseline={null}
      selGrip="Crusher"
      history={[rep(160, 170, 10)]}
      handView="L"
      perHandGripImprovement={{
        "Crusher|L": improvement,
        "Micro|L": improvement,
      }}
      perHandGripEstimates={{}}
      unit="kg"
    />
  );

  expect(screen.getByText("Crusher")).toBeInTheDocument();
  expect(screen.queryByText("Micro")).not.toBeInTheDocument();
});

test("bodyweight scale recomputes improvement instead of relabeling absolute gains", () => {
  render(
    <CurveImprovementCard
      improvement={improvement}
      gripImprovement={{ Crusher: improvement }}
      grip3xEstimates={{ Crusher: [12, 12, 12] }}
      gripBaselines={{ Crusher: { date: "2026-06-01", amps: [10, 10, 10], maxHoldS: 240 } }}
      global3xBaseline={null}
      selGrip="Crusher"
      history={[rep(160, 170, 10, { date: "2026-07-01" })]}
      handView="L"
      perHandGripImprovement={{ "Crusher|L": improvement }}
      perHandGripBaselines={{
        "Crusher|L": { date: "2026-06-01", amps: [10, 10, 10], maxHoldS: 240 },
      }}
      perHandGripEstimates={{ "Crusher|L": [12, 12, 12] }}
      normalizeOn
      bodyWeight={60}
      bwLog={[
        { date: "2026-06-01", kg: 50 },
        { date: "2026-07-01", kg: 60 },
      ]}
      unit="kg"
    />
  );

  expect(screen.getByText("· × BW")).toBeInTheDocument();
  expect(screen.getAllByText("+0%").length).toBeGreaterThan(0);
  expect(screen.queryByText("+12%")).not.toBeInTheDocument();
});

test("shows sparse grips even before they have a current fit", () => {
  render(
    <CurveImprovementCard
      improvement={improvement}
      gripImprovement={{
        Crusher: improvement,
        Micro: improvement,
      }}
      grip3xEstimates={{
        Crusher: [12, 12, 12],
        Micro: [6, 6, 6],
      }}
      gripBaselines={{}}
      global3xBaseline={null}
      selGrip={null}
      grips={["Crusher", "Micro", "Prime"]}
      history={[
        rep(30, 32, 10, { grip: "Prime", date: "2026-07-20" }),
        rep(180, 190, 6, { grip: "Prime", date: "2026-07-27" }),
        rep(180, 120, 6, {
          grip: "Prime",
          date: "2026-07-27",
          rep_num: 2,
        }),
      ]}
      unit="kg"
    />
  );

  expect(screen.getByText("Prime")).toBeInTheDocument();
  expect(screen.getByText(/2 of 5 fresh reps/)).toBeInTheDocument();
  expect(screen.getByText(/2 of 3 target durations/)).toBeInTheDocument();
});
