import React from "react";
import { render, screen } from "@testing-library/react";
import { Btn } from "../components.jsx";
import { C } from "../theme.js";

const luminance = rgb => {
  const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
    const n = v / 255;
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

test.each([C.blue, C.green, C.orange, C.purple, C.red, C.border, "#abc", "#123456"])(
  "button text has at least 4.5:1 contrast on %s", color => {
    render(<Btn color={color}>Save</Btn>);
    const style = getComputedStyle(screen.getByRole("button", { name: "Save" }));
    const light = Math.max(luminance(style.color), luminance(style.backgroundColor));
    const dark = Math.min(luminance(style.color), luminance(style.backgroundColor));
    expect((light + 0.05) / (dark + 0.05)).toBeGreaterThanOrEqual(4.5);
  },
);
