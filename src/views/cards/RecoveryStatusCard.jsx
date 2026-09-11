import React, { useMemo, useState } from "react";
import { useLSValue } from "../../hooks/useLSValue.js";
import { LS_WORKOUT_LOG_KEY } from "../../lib/storage.js";
import { deloadStatus, recoveryStatusDates } from "../../model/deload.js";
import { today } from "../../util.js";
import { DeloadGauge } from "./DeloadGauge.jsx";

export function RecoveryStatusCard({ history }) {
  const workoutLog = useLSValue(LS_WORKOUT_LOG_KEY);
  const todayStr = today();
  const dates = useMemo(() => recoveryStatusDates(history, { today: todayStr }), [history, todayStr]);
  const [selectedDate, setSelectedDate] = useState(null);
  const asOfDate = selectedDate && dates.includes(selectedDate) ? selectedDate : todayStr;
  const status = useMemo(
    () => deloadStatus(history, workoutLog || [], { today: asOfDate }),
    [history, workoutLog, asOfDate]
  );
  return <DeloadGauge status={status} timelineDates={dates} asOfDate={asOfDate}
    currentDate={todayStr} onAsOfDateChange={date => setSelectedDate(date === todayStr ? null : date)} />;
}
