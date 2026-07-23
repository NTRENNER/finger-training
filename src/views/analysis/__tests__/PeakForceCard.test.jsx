import { formatPeakForceTooltip, peakForceTooltipRows } from "../PeakForceCard.jsx";

test("new-PR tooltip names the workout that produced the peak", () => {
  const item = {
    dataKey: "Crusher_newPr",
    payload: {
      Crusher_newPr_context: { label: "Strength" },
    },
  };

  expect(formatPeakForceTooltip(176.4, "Crusher: New PR", item, "lbs")).toEqual([
    "176.4 lbs",
    "Crusher: New PR during Strength workout",
  ]);
});

test("ordinary series keep their original tooltip name", () => {
  const item = { dataKey: "Crusher_pr", payload: {} };

  expect(formatPeakForceTooltip(176.4, "Crusher PR", item, "lbs")).toEqual([
    "176.4 lbs",
    "Crusher PR",
  ]);
});

test("tooltip rows drop scatter internals and replace the matching PR line", () => {
  const source = { Crusher_newPr_context: { label: "Strength" } };
  const rows = peakForceTooltipRows([
    { dataKey: "Crusher_pr", name: "Crusher PR", value: 78, color: "orange", payload: source },
    { dataKey: "Crusher_newPr", name: "Crusher: New PR", value: 78, color: "orange", payload: source },
    { dataKey: "date", name: "date", value: "2026-07-06", payload: source },
    { dataKey: "Micro_pr", name: "Micro PR", value: 25, color: "red", payload: source },
  ], "kg");

  expect(rows).toEqual([
    {
      key: "Crusher_newPr",
      value: "78.0 kg",
      name: "Crusher: New PR during Strength workout",
      color: "orange",
    },
    {
      key: "Micro_pr",
      value: "25.0 kg",
      name: "Micro PR",
      color: "red",
    },
  ]);
});
