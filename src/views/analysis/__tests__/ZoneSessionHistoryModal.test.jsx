import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { ZoneSessionHistoryModal } from "../ZoneSessionHistoryModal.jsx";

const rep = (sessionId, date, actual, load, over = {}) => ({
  session_id: sessionId,
  date,
  grip: "Crusher",
  hand: "L",
  set_num: 1,
  rep_num: 1,
  target_duration: 220,
  actual_time_s: actual,
  avg_force_kg: load,
  ...over,
});

test("shows newest-first session comparisons and closes", () => {
  const onClose = jest.fn();
  render(
    <ZoneSessionHistoryModal
      history={[
        rep("old", "2026-06-01", 190, 10),
        rep("new", "2026-07-24", 230, 11),
      ]}
      grip="Crusher"
      zoneKey="endurance"
      handView="pooled"
      unit="kg"
      onClose={onClose}
    />
  );

  expect(screen.getByRole("dialog")).toHaveTextContent("Endurance history");
  expect(screen.getByText("Crusher · Pooled")).toBeInTheDocument();
  expect(screen.getByText("Jul 24, 2026")).toBeInTheDocument();
  expect(screen.getByText("Latest")).toBeInTheDocument();
  expect(screen.getByText("11.0 kg")).toBeInTheDocument();
  expect(screen.getByText("230 / 220s")).toBeInTheDocument();
  expect(screen.getByText(/\+1 kg vs prior/)).toBeInTheDocument();
  expect(screen.getByText(/\+18\.2pp vs prior/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Close zone history" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("reports when the opening hold landed in a different zone", () => {
  render(
    <ZoneSessionHistoryModal
      history={[rep("under", "2026-07-24", 165, 10)]}
      grip="Crusher"
      zoneKey="endurance"
      unit="kg"
      onClose={() => {}}
    />
  );

  expect(screen.getByText("Opened in Str-End")).toBeInTheDocument();
  expect(screen.getByText(/75% target/)).toBeInTheDocument();
});
