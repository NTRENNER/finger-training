// useTendon — loads the tendon-protocol completion log from the cloud
// and exposes a logger. Self-contained (reads auth via tendonSync), so
// the card can drop into any view without prop threading.
import { useCallback, useEffect, useState } from "react";
import { fetchTendonSessions, pushTendonSession } from "../lib/tendonSync.js";
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
    setSessions(prev => [rec, ...prev]);   // optimistic — reflects in adherence immediately
    await pushTendonSession(rec);
    reload();
    return rec;
  }, [reload]);

  return { sessions, loaded, logSession, reload };
}
