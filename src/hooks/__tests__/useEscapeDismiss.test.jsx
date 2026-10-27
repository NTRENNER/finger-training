import React from "react";
import { fireEvent, render } from "@testing-library/react";
import { useEscapeDismiss } from "../useEscapeDismiss.js";

function Dismissible({ active = true, onDismiss, children }) {
  useEscapeDismiss(active, onDismiss);
  return <div>{children}</div>;
}

test("Escape dismisses the active overlay", () => {
  const outerDismiss = jest.fn();
  const innerDismiss = jest.fn();
  const view = render(
    <Dismissible active={false} onDismiss={outerDismiss}>
      <Dismissible onDismiss={innerDismiss} />
    </Dismissible>
  );

  fireEvent.keyDown(window, { key: "Escape" });
  expect(innerDismiss).toHaveBeenCalledTimes(1);
  expect(outerDismiss).not.toHaveBeenCalled();

  view.rerender(<Dismissible onDismiss={outerDismiss} />);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(outerDismiss).toHaveBeenCalledTimes(1);
});
