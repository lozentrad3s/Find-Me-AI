-- ---------------------------------------------------------------------------
-- Run the safety retention policy on a schedule.
--
-- 0002 defines prune_safety_data() and says to run it on a schedule; until
-- now nothing did. The app already treats alerts older than six hours as
-- expired when it reads them, so this is not what keeps the community map
-- honest. It is what actually deletes things: the minute-by-minute trail of a
-- person in distress once the emergency is a day old, and incident reports
-- after 30 days. A retention policy that never runs is a sentence in a
-- migration, not a policy.
--
-- Kept apart from the grants migration so that if pg_cron is ever unavailable
-- this fails on its own and does not take the security fix down with it.
--
-- anonymise_old_resolutions() is deliberately not scheduled: its retention
-- window is still an open product decision (0001, Part XI decision 9).
-- ---------------------------------------------------------------------------

create extension if not exists pg_cron;

-- Hourly is plenty for windows measured in hours and days. cron.schedule
-- replaces an existing job of the same name, so re-running this is safe.
select cron.schedule(
  'prune-safety-data',
  '7 * * * *',
  $$select public.prune_safety_data()$$
);
