// src/lib/supabase.js
import { createClient } from "@supabase/supabase-js";

const url = process.env.REACT_APP_SUPABASE_URL;
const key = process.env.REACT_APP_SUPABASE_ANON_KEY;

function noop() {}
const fakeSub = { data: { subscription: { unsubscribe: noop } } };

const fakeClient = {
  auth: {
    async getSession() { return { data: { session: null } }; },
    onAuthStateChange() { return fakeSub; },
    async signInWithOtp() { return { error: null }; },
    async signOut() { return { error: null }; },
  },
  from() {
    return {
      async select() { return { data: [], error: null }; },
      async insert() { return { data: [], error: null }; },
      async update() { return { data: [], error: null }; },
      async delete() { return { data: [], error: null }; },
    };
  },
};

export const supabase = (url && key) ? createClient(url, key) : fakeClient;