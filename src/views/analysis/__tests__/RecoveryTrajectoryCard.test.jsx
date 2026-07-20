// The recovery trend series (buildRecoveryTrend) is unit-tested in
// recoveryDynamics.test.js; here we cover the Analysis card wiring:
// it renders with a "higher = better" improvement framing when a grip
// has enough recovery data, and stays hidden (renders nothing) when
// there isn't enough to draw a trend.
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { RecoveryTrajectoryCard } from "../RecoveryTrajectoryCard.jsx";

// recharts' ResponsiveContainer needs ResizeObserver, absent in jsdom.
beforeAll(() => {
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(cleanup);

// Two sessions, each with rep 1 + rep 2 → two recovery datapoints.
const rep = (session_id, date, rep_num, t) => ({
  session_id, date, grip: "Micro", hand: "L",
  set_num: 1, rep_num, actual_time_s: t, rest_s: 20,
});
const history = [
  rep("s1", "2026-06-01", 1, 30), rep("s1", "2026-06-01", 2, 24),
  rep("s2", "2026-06-05", 1, 30), rep("s2", "2026-06-05", 2, 27),
];

test("renders the trajectory card with improvement framing when data exists", () => {
  render(<RecoveryTrajectoryCard history={history} />);
  expect(screen.getByText(/rep-time retention over time/i)).toBeInTheDocument();
  // Explicitly guards against interpreting a duration ratio as direct capacity.
  expect(screen.getByText(/not a direct capacity measurement/i)).toBeInTheDocument();
});

test("stays hidden when there isn't enough recovery data", () => {
  const { container } = render(<RecoveryTrajectoryCard history={[]} />);
  expect(container.firstChild).toBeNull();
});

test("stays hidden with only a single recovery datapoint", () => {
  const { container } = render(
    <RecoveryTrajectoryCard history={[rep("s1", "2026-06-01", 1, 30), rep("s1", "2026-06-01", 2, 24)]} />
  );
  expect(container.firstChild).toBeNull();
});
