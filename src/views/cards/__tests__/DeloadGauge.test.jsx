import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { DeloadGauge } from "../DeloadGauge.jsx";

const greenStatus = {
  level: "green",
  pressure: 0.2,
  label: "Fresh — absorbing your load well",
  haveSignal: true,
  deload: { severity: "none" },
};

test("scrubs recovery checkpoints and labels the live endpoint Now", () => {
  const onChange = jest.fn();
  const timelineDates = ["2026-06-01", "2026-06-15", "2026-07-23"];
  const { rerender } = render(
    <DeloadGauge
      status={greenStatus}
      timelineDates={timelineDates}
      asOfDate="2026-07-23"
      currentDate="2026-07-23"
      onAsOfDateChange={onChange}
    />
  );

  const slider = screen.getByRole("slider", { name: "Recovery status history" });
  expect(slider).toHaveValue("2");
  expect(screen.getByText(/As of:/).textContent).toContain("Now");

  fireEvent.change(slider, { target: { value: "0" } });
  expect(onChange).toHaveBeenCalledWith("2026-06-01");

  rerender(
    <DeloadGauge
      status={greenStatus}
      timelineDates={timelineDates}
      asOfDate="2026-06-01"
      currentDate="2026-07-23"
      onAsOfDateChange={onChange}
    />
  );
  expect(screen.getByText(/As of:/).textContent).toContain("Jun 1, 2026");
  expect(screen.getByText(/How close you were/i)).toBeInTheDocument();
});

test("hides the slider until there is historical range to scrub", () => {
  render(
    <DeloadGauge
      status={greenStatus}
      timelineDates={["2026-07-23"]}
      asOfDate="2026-07-23"
      currentDate="2026-07-23"
      onAsOfDateChange={() => {}}
    />
  );

  expect(screen.queryByRole("slider", { name: "Recovery status history" })).not.toBeInTheDocument();
});

// ── Collapse (September 2026) ────────────────────────────────
// The card collapses to one line while it is green. The first cut put
// the reopen affordance on the collapsed row but the close affordance
// in a muted 11px word beside the title, and the first person to use it
// reported there was no way to close the card. The whole header row is
// now the control.
describe("collapsing", () => {
  test("collapsed shows one line and nothing that explains the reading", () => {
    render(<DeloadGauge status={greenStatus} expanded={false} onToggleExpanded={jest.fn()} />);
    expect(screen.getByText(greenStatus.label)).toBeInTheDocument();
    expect(screen.queryByText(/How close you/)).not.toBeInTheDocument();
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  });

  test("the collapsed row opens the card", () => {
    const onToggle = jest.fn();
    render(<DeloadGauge status={greenStatus} expanded={false} onToggleExpanded={onToggle} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  test("the expanded header closes it again — the reported bug", () => {
    const onToggle = jest.fn();
    render(<DeloadGauge status={greenStatus} expanded onToggleExpanded={onToggle} />);
    const header = screen.getByRole("button", { expanded: true });
    expect(header).toHaveTextContent("Recovery status");
    fireEvent.click(header);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  test("the expanded header is reachable from the keyboard", () => {
    const onToggle = jest.fn();
    render(<DeloadGauge status={greenStatus} expanded onToggleExpanded={onToggle} />);
    const header = screen.getByRole("button", { expanded: true });
    expect(header).toHaveAttribute("tabIndex", "0");
    fireEvent.keyDown(header, { key: "Enter" });
    fireEvent.keyDown(header, { key: " " });
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  test("a caller that passes no toggle gets the old always-open card", () => {
    render(<DeloadGauge status={greenStatus} />);
    expect(screen.getByText(/How close you/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { expanded: true })).not.toBeInTheDocument();
  });
});
