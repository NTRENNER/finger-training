import { addRepDefaultHand } from "../HistoryView.js";

describe("addRepDefaultHand", () => {
  test("STICKY wins over the session hand — the bug case", () => {
    expect(addRepDefaultHand({
      sticky: { sessKey: "s1", hand: "R" }, sessKey: "s1", sessHand: "L", reps: [],
    })).toBe("R");
  });
  test("sticky from a DIFFERENT session is ignored", () => {
    expect(addRepDefaultHand({
      sticky: { sessKey: "other", hand: "R" }, sessKey: "s1", sessHand: "L", reps: [],
    })).toBe("L");
  });
  test("no sticky → single-hand session uses its own hand", () => {
    expect(addRepDefaultHand({ sticky: null, sessKey: "s1", sessHand: "L" })).toBe("L");
    expect(addRepDefaultHand({ sticky: null, sessKey: "s1", sessHand: "R" })).toBe("R");
  });
  test("no sticky → Both session alternates from the last rep", () => {
    expect(addRepDefaultHand({ sticky: null, sessKey: "s1", sessHand: "B",
      reps: [{ hand: "L" }, { hand: "L" }] })).toBe("R");
    expect(addRepDefaultHand({ sticky: null, sessKey: "s1", sessHand: "B",
      reps: [{ hand: "R" }] })).toBe("L");
  });
  test("garbage sticky hand is ignored; falls through", () => {
    expect(addRepDefaultHand({
      sticky: { sessKey: "s1", hand: "B" }, sessKey: "s1", sessHand: "R", reps: [],
    })).toBe("R");
  });
  test("nothing usable → L", () => {
    expect(addRepDefaultHand({ sticky: null, sessKey: "s1", sessHand: null })).toBe("L");
  });
});
