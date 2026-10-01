# Ownership of pending cloud work

All data API traffic is bound to the immutable local page owner. Before a writer
stamps `user_id`, authenticated identity must match both the page namespace and
the last-user marker. Reps, activity, workout, ratings and settings follow that
rule. Queue completion also rechecks ownership before clearing pending work.

The Supabase SDK can resolve its access token after the caller's check. Therefore
a custom fetch boundary checks that the request token's subject still matches the
page owner, including RPC and direct writes outside sync.js. This is a client
consistency guard, not authentication: the server still verifies JWTs and enforces
RLS. Auth endpoints are excluded so login/logout can proceed. No tokens are logged.
Responses after an account switch are rejected and leave local work available for
retry by its original owner. Anonymous work waits for adoption and reload.

An account-switch reproduction motivated this change; it did not demonstrate any
real production data mixing. No database policy or recorded workout was changed.
