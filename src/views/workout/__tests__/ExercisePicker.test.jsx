import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { ExercisePicker } from "../ExercisePicker.jsx";

test("surfaces the lock-off eccentric as the suggested TRX-row substitute", () => {
  const onPick = jest.fn();

  render(
    <ExercisePicker
      substituteForId="trxRow"
      excludeIds={[]}
      onPick={onPick}
      onCancel={() => {}}
    />
  );

  const button = screen.getByRole("button", { name: /90° Lock-Off \+ Eccentric/ });
  expect(screen.getByText("suggested substitute")).toBeInTheDocument();

  fireEvent.click(button);
  expect(onPick).toHaveBeenCalledWith(
    expect.objectContaining({ id: "lockoffEccentric" })
  );
});
