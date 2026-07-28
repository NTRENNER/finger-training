import React from "react";
import { render, screen } from "@testing-library/react";
import { PAGE_MAX_WIDTH, PageFrame } from "../components.js";

test("provides the shared fluid page-width contract", () => {
  render(
    <PageFrame data-testid="page" style={{ padding: "20px 16px" }}>
      Content
    </PageFrame>
  );

  expect(PAGE_MAX_WIDTH).toBe(720);
  const page = screen.getByTestId("page");
  expect(page).toHaveAttribute("data-page-frame");
  expect(page).toHaveStyle({
    width: "100%",
    maxWidth: "720px",
    margin: "0 auto",
    boxSizing: "border-box",
    padding: "20px 16px",
  });
});
