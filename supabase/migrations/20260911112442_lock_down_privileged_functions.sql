-- ---------------------------------------------------------------------------
-- Grants, and closing the public door on the privileged functions.
--
-- 1. Table grants.
--    Projects created after May 2026 no longer grant table access to the API
--    roles by default (Supabase changelog 45329) — not even to service_role.
--    The safety store reaches its tables through the Data API with the service
--    role key, so without these grants every SOS write fails with 42501 and the
--    app falls back to memory: an emergency alert that vanishes when an
--    instance recycles.
--
--    Only service_role is granted. anon and authenticated get nothing: every
--    access goes through a route handler, and the RLS policies in 0001 stay
--    dormant until a client actually needs them. Exposing a table is a
--    decision for the migration that needs it, not a default.
--
-- 2. Function execute.
--    Postgres grants EXECUTE on every new function to PUBLIC. The three
--    functions below are SECURITY DEFINER, so they bypass RLS — and as they
--    stood, anyone holding the public anon key could call them through
--    /rest/v1/rpc:
--      confirm_incident          inflate a report's confirmations with made-up
--                                device hashes, and read the reporter hash back
--      prune_safety_data         expire live alerts and delete reports early
--      anonymise_old_resolutions strip the author from every resolution, by
--                                passing a zero-length retention window
--    confirm_incident is called by the server with the service role; the other
--    two are for scheduled jobs, which run as their owner.
-- ---------------------------------------------------------------------------

grant select, insert, update, delete
  on public.sos_alerts,
     public.incident_reports,
     public.incident_confirmations
  to service_role;

grant select, insert, update, delete
  on public.resolutions,
     public.place_corrections,
     public.place_aliases,
     public.landmarks
  to service_role;

revoke execute on function public.confirm_incident(uuid, text)
  from public, anon, authenticated;
revoke execute on function public.prune_safety_data()
  from public, anon, authenticated;
revoke execute on function public.anonymise_old_resolutions(interval)
  from public, anon, authenticated;

grant execute on function public.confirm_incident(uuid, text) to service_role;
