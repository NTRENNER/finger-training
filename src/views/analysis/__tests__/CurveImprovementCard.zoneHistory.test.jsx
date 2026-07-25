import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { CurveImprovementCard } from "../CurveImprovementCard.jsx";

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
