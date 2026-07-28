import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { AnalysisScopeToolbar } from "../AnalysisScopeToolbar.jsx";

function Harness() {
  const [grip, setGrip] = useState("");
  const [hand, setHand] = useState("pooled");
  const [normalizeOn, setNormalizeOn] = useState(false);
  return (
    <AnalysisScopeToolbar
      grips={["Crusher", "Micro"]}
      grip={grip}
      onGripChange={setGrip}
      hand={hand}
      onHandChange={setHand}
      normalizeOn={normalizeOn}
      onNormalizeChange={setNormalizeOn}
      canNormalize
      attentionCounts={{ Crusher: 2 }}
    />
  );
}

test("one scope controls grip, hand, and scale", () => {
  render(<Harness />);

  const crusher = screen.getByRole("button", {
    name: "Crusher, 2 coverage items",
  });
  fireEvent.click(crusher);
  expect(crusher).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "All Grips, 2 coverage items" }))
    .toHaveAttribute("aria-pressed", "false");

  fireEvent.click(screen.getByRole("button", { name: "Right" }));
  expect(screen.getByRole("button", { name: "Right" }))
    .toHaveAttribute("aria-pressed", "true");

  fireEvent.click(screen.getByRole("button", { name: "× BW" }));
  expect(screen.getByRole("button", { name: "× BW" }))
    .toHaveAttribute("aria-pressed", "true");
});
