-- ===========================================================================
-- 0049 — the three nonconformity permissions, and NOTHING ELSE.
--
-- ---------------------------------------------------------------------------
-- WHY THIS MIGRATION CONTAINS ONE KIND OF STATEMENT
-- ---------------------------------------------------------------------------
-- `app_permission` is a Postgres enum, not only a TypeScript union. A new
-- enum value CANNOT BE USED in the same transaction that adds it — the
-- insert into `role_permissions`, and any policy or function referencing
-- `'nc.raise'::app_permission`, would fail with "unsafe use of new value of
-- enum type" even though the ALTER itself succeeded.
--
-- So the values are added here, alone, and everything that uses them is in
-- 0050 onwards. Splitting them is not tidiness; it is the only order that
-- applies.
--
-- The plan for this phase originally said the three permissions were an edit
-- to `src/lib/roles.ts`. That is the mirror. This is the original.
--
-- ---------------------------------------------------------------------------
-- WHAT EACH ONE IS FOR
-- ---------------------------------------------------------------------------
--   nc.raise   open a nonconformity. Held by operators as well as quality
--              staff: an operator already holds `hold.raise`, and a hold
--              creates a nonconformity, so they must be able to raise what
--              their own action creates.
--   nc.act     record the correction, the root cause and the corrective-
--              action evaluation; add, complete and reassign actions.
--   nc.close   verify, close and void.
--
-- Reading needs no new permission: anyone who may read a sample may read a
-- nonconformity, auditors included.
-- ===========================================================================

alter type public.app_permission add value if not exists 'nc.raise';
alter type public.app_permission add value if not exists 'nc.act';
alter type public.app_permission add value if not exists 'nc.close';
