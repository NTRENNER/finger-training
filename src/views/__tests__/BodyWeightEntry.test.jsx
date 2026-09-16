import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BwPrompt, BodyWeightEntry } from "../BodyWeightEntry.jsx";
import { HistoryView } from "../HistoryView.js";
import { bodyWeightReminderDue, latestBodyWeight } from "../../lib/bodyWeight.js";
import { LS_BW_LOG_KEY, LS_BW_REMINDER_DISMISSED_KEY, LS_HISTORY_DOMAIN_KEY, loadLS, saveLS } from "../../lib/storage.js";
import { fromDisp } from "../../ui/format.js";

jest.mock("../../lib/sync.js", () => ({ deleteBW: jest.fn() }));
beforeAll(() => {
  // jsdom has the dialog element, but not its browser focus/top-layer API.
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date("2026-09-16T12:00:00"));
  saveLS(LS_BW_LOG_KEY, []);
  saveLS(LS_BW_REMINDER_DISMISSED_KEY, null);
});
afterEach(() => jest.useRealTimers());

test("reminds at seven calendar days, including across DST, using the latest valid entry", () => {
  const latest = latestBodyWeight([{ date: "2026-09-15", kg: 70 }, { date: "2026-09-01", kg: 71 }, { date: "2026-09-20", kg: 72 }]);
  expect(latest.date).toBe("2026-09-15");
  expect(bodyWeightReminderDue(latest, null)).toBe(false);
  expect(bodyWeightReminderDue({ date: "2026-09-10" }, null)).toBe(false);
  expect(bodyWeightReminderDue({ date: "2026-09-09" }, null)).toBe(true);
  expect(bodyWeightReminderDue({ date: "2026-03-02" }, null, "2026-03-09")).toBe(true);
  expect(bodyWeightReminderDue(null, null)).toBe(true);
});

test("Not now suppresses the reminder after remount that day but not the next day", () => {
  saveLS(LS_BW_LOG_KEY, [{ date: "2026-09-09", kg: 70 }]);
  const view = render(<BwPrompt onSave={jest.fn()} />);
  expect(screen.getByRole("dialog")).toHaveTextContent("2026-09-09");
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  expect(loadLS(LS_BW_REMINDER_DISMISSED_KEY)).toBe("2026-09-16");
  view.unmount();
  const next = render(<BwPrompt onSave={jest.fn()} />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  next.unmount();
  jest.setSystemTime(new Date("2026-09-17T12:00:00"));
  render(<BwPrompt onSave={jest.fn()} />);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

test("fresh entries and a cloud update suppress the reminder", () => {
  saveLS(LS_BW_LOG_KEY, [{ date: "2026-09-15", kg: 70 }]);
  render(<BwPrompt onSave={jest.fn()} />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  act(() => saveLS(LS_BW_LOG_KEY, []));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  act(() => saveLS(LS_BW_LOG_KEY, [{ date: "2026-09-16", kg: 70 }]));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("weekly Save retains decimal pounds, logs today, and closes", async () => {
  const onSave = jest.fn();
  render(<BwPrompt unit="lbs" onSave={onSave} />);
  fireEvent.change(screen.getByLabelText("Today's weight (lbs)"), { target: { value: "157.4" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(onSave).toHaveBeenCalledWith(fromDisp(157.4, "lbs"), "2026-09-16");
});

test("history can log a past date and correct it through the same save callback", async () => {
  saveLS(LS_HISTORY_DOMAIN_KEY, "weight");
  const onSave = jest.fn((kg, date) => {
    const log = loadLS(LS_BW_LOG_KEY) || [];
    saveLS(LS_BW_LOG_KEY, [...log.filter(e => e.date !== date), { date, kg }]);
  });
  render(<HistoryView history={[]} unit="kg" onBwSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: "Log weight" }));
  fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-01" } });
  fireEvent.change(screen.getByLabelText("Weight (kg)"), { target: { value: "72.3" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(onSave).toHaveBeenLastCalledWith(72.3, "2026-09-01");
  fireEvent.click(screen.getByRole("button", { name: "Edit weight for 2026-09-01" }));
  expect(screen.getByLabelText("Date")).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Weight (kg)"), { target: { value: "71.8" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(loadLS(LS_BW_LOG_KEY)).toEqual([{ date: "2026-09-01", kg: 71.8 }]);
});

test("entry rejects empty weight and future dates without saving", () => {
  const onSave = jest.fn();
  render(<BodyWeightEntry onSave={onSave} onClose={jest.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert")).toHaveTextContent("greater than zero");
  fireEvent.change(screen.getByLabelText("Weight (lbs)"), { target: { value: "155" } });
  fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-17" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert")).toHaveTextContent("date in the past");
  expect(onSave).not.toHaveBeenCalled();
});

test("confirming the prefilled value preserves kg precision", async () => {
  const onSave = jest.fn();
  const onClose = jest.fn();
  render(<BodyWeightEntry latest={{ date: "2026-09-01", kg: 71.45678 }} unit="lbs" onSave={onSave} onClose={onClose} />);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(onSave).toHaveBeenCalledWith(71.45678, "2026-09-16");
});
