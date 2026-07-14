// Cloud sync for the tendon-protocol completion log (tendon_sessions).
// Kept out of lib/sync.js on purpose — this track is fully independent
// of the reps/workout/climb sync machinery. Per-user RLS on the table
// isolates rows; we still attach user_id explicitly so WITH CHECK passes.
import { supabase } from "./supabase.js";

async function currentUserId() {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    return user?.id ?? null;
  } catch (e) {
    return null;
  }
}

export async function pushTendonSession(session) {
  const userId = await currentUserId();
  if (!userId) return false;
  try {
    const { error } = await supabase.from("tendon_sessions").upsert({
      id:           session.id,
      user_id:      userId,
      date:         session.date,
      preset:       session.preset ?? null,
      sets:         session.sets ?? null,
      total_work_s: session.total_work_s ?? null,
      note:         session.note ?? null,
    }, { onConflict: "id" });
    if (error) { console.warn("tendon push:", error.message); return false; }
    return true;
  } catch (e) {
    console.warn("tendon push exception:", e.message);
    return false;
  }
}

export async function fetchTendonSessions() {
  try {
    const { data, error } = await supabase
      .from("tendon_sessions")
      .select("id, date, created_at, preset, sets, total_work_s, note")
      .order("date", { ascending: false });
    if (error) { console.warn("tendon fetch:", error.message); return null; }
    return data || [];
  } catch (e) {
    console.warn("tendon fetch exception:", e.message);
    return null;
  }
}

export async function deleteTendonSession(id) {
  try {
    const { error } = await supabase.from("tendon_sessions").delete().eq("id", id);
    return !error;
  } catch (e) {
    return false;
  }
}
