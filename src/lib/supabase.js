// src/lib/supabase.js
import { createClient } from "@supabase/supabase-js";

// Read from environment variables (defined in .env.local)
const supabaseUrl = process.env.REACT_APP_SUPABASE_URL;
const supabaseKey = process.env.REACT_APP_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// Optional debug logs (visible in browser console)
console.log("Supabase URL:", supabaseUrl);
console.log("Supabase Key starts with:", supabaseKey?.slice(0, 10));