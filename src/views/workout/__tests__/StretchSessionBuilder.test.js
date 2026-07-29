import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { StretchSessionBuilder } from "../StretchSessionBuilder.js";
import { DEFAULT_STRETCH_PREFERENCES } from "../../../model/stretching.js";

const emptyCoverage = {
  hipRotation: 0,
  hamstrings: 0,
  highStep: 0,
  hipOpening: 0,
  hipExtension: 0,
  forearms: 0,
  overhead: 0,
  chest: 0,
};

function Harness({ onLog = () => {} }) {
  const [preferences, setPreferences] = useState(DEFAULT_STRETCH_PREFERENCES);
  return (
    <StretchSessionBuilder
      preferences={preferences}
      coverage={emptyCoverage}
      onPreferencesChange={setPreferences}
      onLog={onLog}
    />
  );
}

describe("StretchSessionBuilder", () => {
  test("renders an equipment-free ten-minute plan", () => {
    render(<Harness />);
    expect(screen.getByText("Climbing Mobility")).toBeInTheDocument();
    expect(screen.getByText("Elephant Walks")).toBeInTheDocument();
    expect(screen.getByText("Standing High-Step Pull-In")).toBeInTheDocument();
    expect(screen.getByText("Shin Boxes")).toBeInTheDocument();
    expect(screen.getByText("Wrist and Finger Rock-Backs")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View Elephant Walks demo" }))
      .toHaveAttribute("href", "https://www.youtube.com/watch?v=fnih_6w_JjA");
    expect(screen.getByRole("button", { name: "Log 10 minutes" })).toBeEnabled();
  });

  test("equipment and priority controls produce the equipped movement", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Overhead reach priority" }));
    fireEvent.click(screen.getByRole("button", { name: "Band available" }));
    expect(screen.getByText("Banded Lat Stretch")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View Banded Lat Stretch demo" }))
      .toHaveAttribute("href", "https://www.youtube.com/watch?v=WUFuWuYf_u0");
  });

  test("swap menus expose demos without nesting links inside selection buttons", () => {
    render(<Harness />);
    const swapButtons = screen.getAllByRole("button", { name: "Swap" });
    fireEvent.click(swapButtons[0]);
    const demo = screen.getByRole("link", { name: "View Seated Pancake Hinge demo" });
    expect(demo).toHaveAttribute("target", "_blank");
    expect(demo.closest("button")).toBeNull();
  });

  test("logs the selected plan with the full time allocation", () => {
    const onLog = jest.fn();
    render(<Harness onLog={onLog} />);
    fireEvent.click(screen.getByRole("button", { name: "Log 10 minutes" }));
    expect(onLog).toHaveBeenCalledTimes(1);
    const payload = onLog.mock.calls[0][0];
    expect(payload.items.reduce((sum, item) => sum + item.minutes, 0)).toBe(10);
    expect(payload.items.every(item => item.exercise?.id)).toBe(true);
  });

  test("completed sessions show their recorded exercises and minutes", () => {
    render(
      <StretchSessionBuilder
        preferences={DEFAULT_STRETCH_PREFERENCES}
        coverage={emptyCoverage}
        completedSession={{
          exercises: {
            shinBoxes: { done: true, minutes: 2, category: "hipRotation" },
            couchStretch: { done: true, minutes: 3, category: "hipExtension" },
          },
        }}
        onRemove={() => {}}
      />
    );
    expect(screen.getByText("5 minutes logged today")).toBeInTheDocument();
    expect(screen.getByText("Shin Boxes")).toBeInTheDocument();
    expect(screen.getByText("Couch Stretch")).toBeInTheDocument();
  });
});
