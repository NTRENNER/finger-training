import React, { useMemo, useState } from "react";
import { useLSValue } from "../../hooks/useLSValue.js";
import { LS_WORKOUT_LOG_KEY } from "../../lib/storage.js";
import { deloadStatus, recoveryStatusDates } from "../../model/deload.js";
import { today } from "../../util.js";
import { DeloadGauge } from "./DeloadGauge.jsx";

export function RecoveryStatusCard({ history, activities = [], defaultExpanded = false }) {
  const workoutLog = useLSValue(LS_WORKOUT_LOG_KEY);
  const todayStr = today();
  const dates = useMemo(() => recoveryStatusDates(history, { today: todayStr }), [history, todayStr]);
  const [selectedDate, setSelectedDate] = useState(null);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const asOfDate = selectedDate && dates.includes(selectedDate) ? selectedDate : todayStr;
  const status = useMemo(
    () => deloadStatus(history, workoutLog || [], { today: asOfDate, activities }),
    [history, workoutLog, activities, asOfDate]
  );
  // Quiet until it has something to say: green collapses to a line and
  // anything else opens itself. Scrubbing the history keeps it open, so
  // collapsing also returns the scrubber to "Now" — otherwise the toggle
  // appears not to work, because the scrub is holding the card open.
  const demand = status && status.level !== "green" && status.level !== "unknown";
  const scrubbing = asOfDate !== todayStr;
  return <DeloadGauge status={status} timelineDates={dates} asOfDate={asOfDate}
    currentDate={todayStr}
    expanded={expanded || demand || scrubbing}
    onToggleExpanded={() => { setSelectedDate(null); setExpanded(v => !v); }}
    onAsOfDateChange={date => setSelectedDate(date === todayStr ? null : date)} />;
}
