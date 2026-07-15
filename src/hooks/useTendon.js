// useTendon — loads the tendon-protocol completion log from the cloud
// and exposes log/remove. Self-contained (reads auth via tendonSync),
// so both the Setup card and the History list can use it independently.
import { useCallback, useEffect, useState } from "react";
import { fetchTendonSessions, pushTendonSession, deleteTendonSession } from "../lib/tendonSync.js";
import { uuid, today } from "../util.js";

export function useTendon() {
  const [sessions, setSessions] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    const rows = await fetchTendonSessions();
    if (rows) setSessions(rows);
    setLoaded(true);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const logSession = useCallback(async ({ preset, sets, totalWorkS }) => {
    const rec = { id: uuid(), date: today(), preset, sets, total_work_s: totalWorkS };
    setSessions(prev => [rec, ...prev]);   // optimistic
    await pushTendonSession(rec);
    reload();
    return rec;
  }, [reload]);

  const removeSession = useCallback(async (id) => {
    setSessions(prev => prev.filter(s => s.id !== id));   // optimistic
    await deleteTendonSession(id);
    reload();
  }, [reload]);

  return { sessions, loaded, logSession, removeSession, reload };
}
