import React, { useMemo, useState } from "react";
import { useLSValue } from "../../hooks/useLSValue.js";
import { LS_WORKOUT_LOG_KEY } from "../../lib/storage.js";
import { deloadStatus, recoveryStatusDates } from "../../model/deload.js";
import { today } from "../../util.js";
import { DeloadGauge } from "./DeloadGauge.jsx";

export function RecoveryStatusCard({ history, activities = [] }) {
  const workoutLog = useLSValue(LS_WORKOUT_LOG_KEY);
  const todayStr = today();
  const dates = useMemo(() => recoveryStatusDates(history, { today: todayStr }), [history, todayStr]);
  const [selectedDate, setSelectedDate] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const asOfDate = selectedDate && dates.includes(selectedDate) ? selectedDate : todayStr;
  const status = useMemo(
    () => deloadStatus(history, workoutLog || [], { today: asOfDate, activities }),
    [history, workoutLog, activities, asOfDate]
  );
  // Quiet until it has something to say. The gauge held the top of this
  // tab with a full-width gradient for five months of unbroken green;
  // prominence should track information content, so green collapses to a
  // line and anything else opens itself. Scrubbing history keeps it open.
  const demand = status && status.level !== "green" && status.level !== "unknown";
  return <DeloadGauge status={status} timelineDates={dates} asOfDate={asOfDate}
    currentDate={todayStr}
    expanded={expanded || demand || asOfDate !== todayStr}
    onToggleExpanded={() => setExpanded(v => !v)}
    onAsOfDateChange={date => setSelectedDate(date === todayStr ? null : date)} />;
}
