// Release policy constant; measurement and BLE lifecycle behavior are covered
// by tindeq.recording.test.js, tindeq.gatt.test.jsx and forceRecording.test.js.
import { AUTO_RELEASE_CONFIRM_MS } from "../tindeq.js";

test("requires a full second below the release threshold", () => {
  expect(AUTO_RELEASE_CONFIRM_MS).toBe(1000);
});
