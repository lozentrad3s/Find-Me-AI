-- ---------------------------------------------------------------------------
-- Take the public API roles off the app tables, and tidy 0001's policies.
--
-- 1. Table access.
--    This project was created with Supabase's older default, which grants
--    anon and authenticated full access to every new table in public. So the
--    previous migration's note that those roles "get nothing" was wrong here:
--    the safety tables were protected by RLS alone (on, with no policies).
--
--    Nothing in the app talks to Supabase from the browser — every read and
--    write goes through a route handler with the service role — so the public
--    roles need no table access at all. Removing it means a future policy
--    written by mistake cannot expose live SOS positions on its own. When a
--    feature does need browser access (auth, saved places), its migration
--    grants exactly what it uses; the policies below are ready for that.
--
-- 2. Policies (Supabase advisors: auth_rls_initplan, multiple_permissive).
--    Same rules as 0001, rewritten so they can be granted safely later:
--      * (select auth.uid()) is evaluated once per query, not once per row
--      * each policy names its roles instead of applying to PUBLIC
--      * aliases_write_own (FOR ALL) is split per command, so SELECT on
--        place_aliases is governed by one policy, not two
-- ---------------------------------------------------------------------------

revoke all
  on public.sos_alerts,
     public.incident_reports,
     public.incident_confirmations,
     public.resolutions,
     public.place_corrections,
     public.place_aliases,
     public.landmarks
  from anon, authenticated;

-- --- resolutions -----------------------------------------------------------

drop policy if exists resolutions_own on public.resolutions;
create policy resolutions_own on public.resolutions
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- Anonymous attempts are still data (0001): user_id may be null.
drop policy if exists resolutions_insert on public.resolutions;
create policy resolutions_insert on public.resolutions
  for insert to anon, authenticated
  with check (user_id is null or (select auth.uid()) = user_id);

drop policy if exists resolutions_update_own on public.resolutions;
create policy resolutions_update_own on public.resolutions
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- --- place_corrections -----------------------------------------------------

drop policy if exists corrections_own on public.place_corrections;
create policy corrections_own on public.place_corrections
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists corrections_insert on public.place_corrections;
create policy corrections_insert on public.place_corrections
  for insert to anon, authenticated
  with check (user_id is null or (select auth.uid()) = user_id);

-- --- place_aliases ---------------------------------------------------------

drop policy if exists aliases_readable on public.place_aliases;
create policy aliases_readable on public.place_aliases
  for select to anon, authenticated
  using (user_id is null or (select auth.uid()) = user_id);

drop policy if exists aliases_write_own on public.place_aliases;
create policy aliases_insert_own on public.place_aliases
  for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy aliases_update_own on public.place_aliases
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy aliases_delete_own on public.place_aliases
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- --- landmarks -------------------------------------------------------------

drop policy if exists landmarks_readable on public.landmarks;
create policy landmarks_readable on public.landmarks
  for select to anon, authenticated
  using (true);
