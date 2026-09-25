-- Tubed daily leaderboard schema.
--
-- There's no migration runner in this project (no package.json, no CI deploy
-- step) so this file isn't applied automatically. Run it once, by hand, in
-- the Supabase SQL editor for the project. It's committed here purely so the
-- schema has version history alongside the client code that depends on it.
--
-- Ranking metric, in order: diff_mins (minutes off the optimal route), then
-- completion_secs, then hints_used. diff_mins leads because it is already
-- the game's headline stat (it drives the medal in index.html and the
-- share-card blocks), so the board rewards the skill the game actually
-- tests rather than typing speed. hints_used only separates players who
-- matched on BOTH route and time; identical on all three is a genuine tie
-- and they share a rank.

create table public.scores (
  id              bigint generated always as identity primary key,
  puzzle_date     date not null,
  mode            text not null check (mode in ('easy','hard')),
  player_id       uuid not null,
  diff_mins       integer not null check (diff_mins >= 0),
  -- Upper bound only. A low floor would silently drop legitimate fast solves
  -- (a failed CHECK means no row and no leaderboard entry, with nothing shown
  -- to the player), and buys nothing against real cheating — a fabricated
  -- request would just send whatever the floor is.
  completion_secs integer not null check (completion_secs between 0 and 21600),
  hints_used      smallint not null default 0 check (hints_used >= 0),

  -- Analytics context, all NULLABLE on purpose: a column that can reject an
  -- insert can silently keep a player off the board, and none of these are
  -- worth that risk. A stale cached client that doesn't send them just
  -- records NULL.
  --
  -- scoring_version matters most and cannot be reconstructed later. The cost
  -- model genuinely moves (wait times, OSI walks, interchange penalties), so
  -- without it a diff_mins from March is quietly incomparable to one from
  -- September. user_mins/optimal_mins make each row self-describing, which
  -- is what allows absolute facts ("6 min off optimal on average") rather
  -- than only relative ones.
  user_mins       integer check (user_mins is null or user_mins >= 0),
  optimal_mins    integer check (optimal_mins is null or optimal_mins >= 0),
  scoring_version integer check (scoring_version is null or scoring_version > 0),

  created_at      timestamptz not null default now(),
  unique (puzzle_date, mode, player_id)
);

alter table public.scores enable row level security;

-- Anyone can submit one score for TODAY's (London) puzzle, for their own
-- player_id, with a 1-day grace window for clock skew around midnight.
-- The UNIQUE constraint above is the real anti-cheat lever: once a
-- (puzzle_date, mode, player_id) row exists, this INSERT can never overwrite
-- it — a resubmission after editing localStorage and replaying just no-ops.
-- There is deliberately no UPDATE policy on score fields at all.
create policy "insert own score for a recent date"
  on public.scores for insert to anon
  with check (
    puzzle_date >= (now() at time zone 'Europe/London')::date - 1
    and puzzle_date <= (now() at time zone 'Europe/London')::date
  );

-- Explicit least-privilege grants, because this project is set up with
-- "Automatically expose new tables" DISABLED. anon therefore starts with no
-- privileges here, and INSERT has to be granted deliberately: an RLS policy
-- filters rows only AFTER a table-level grant lets the role in at all, so
-- the policy above does nothing without this.
grant usage on schema public to anon;
grant insert on public.scores to anon;

-- Deliberately NO select grant — that would hand out every player_id and
-- let one player read another's row. All reads go through the SECURITY
-- DEFINER function below, which returns only an aggregate. The revoke is
-- belt-and-braces in case the table was ever auto-exposed.
revoke select on public.scores from anon;

-- Rank + percentile for one player, computed fresh on every call (no
-- materialized leaderboard to keep in sync). top_pct is "you're in the top
-- N%" directly (rank 1 of 200 -> top_pct 1, floored at 1 so nobody sees
-- "top 0%"). total_players < 5 is treated as too small a sample by the
-- client, not here — this function always reports the true numbers.
--
-- median_optimal_secs is the anchor players aim at: the typical time taken
-- by everyone who found the optimal route today. MEDIAN, not mean —
-- completion_secs has a long tail from players who leave the tab open
-- mid-solve, and one 40-minute entry would drag a mean badly. optimal_count
-- ships alongside it so the client can refuse to quote a "typical" time
-- derived from one or two solvers.
create or replace function public.get_leaderboard_stats(
  p_date date, p_mode text, p_player uuid
) returns json
language sql
stable
security definer
set search_path = public
as $$
  with ranked as (
    select player_id, diff_mins, completion_secs,
           rank() over (order by diff_mins asc, completion_secs asc, hints_used asc) as rnk,
           count(*) over () as total
    from public.scores
    where puzzle_date = p_date and mode = p_mode
  ),
  optimal as (
    -- Always exactly one row: n = 0 and median = null on an empty day.
    select count(*) as n,
           percentile_cont(0.5) within group (order by completion_secs) as median_secs
    from public.scores
    where puzzle_date = p_date and mode = p_mode and diff_mins = 0
  )
  select json_build_object(
    'total_players', coalesce((select max(total) from ranked), 0),
    'my_rank',        (select rnk from ranked where player_id = p_player),
    'top_pct',        (select greatest(1, round(100.0 * rnk / total, 0))
                        from ranked where player_id = p_player),
    'is_top3',        coalesce((select rnk <= 3 from ranked where player_id = p_player), false),
    'optimal_count',  (select n from optimal),
    'median_optimal_secs', (select round(median_secs)::int from optimal)
  );
$$;
grant execute on function public.get_leaderboard_stats(date, text, uuid) to anon;

-- Deliberately no player-supplied text anywhere in this schema. Without
-- accounts there is no way to ban an abuser (a player_id resets by clearing
-- localStorage) and no moderation capacity, so the table stores only numbers.
-- A future visible board should derive a readable handle from player_id
-- rather than ever accepting typed input.
--
-- Streaks are deliberately NOT stored: (player_id, puzzle_date) already
-- implies them via a window function over consecutive dates, and a stored
-- copy would be a second source of truth free to drift from the client's.


-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRATIONS
-- ═══════════════════════════════════════════════════════════════════════════
-- The table definition above is the canonical fresh install. Databases
-- created before a change need the matching statement below. Each is
-- idempotent, so re-running is harmless.

-- 2026-09-25 — analytics context columns.
-- Run this BEFORE deploying the client that sends them: PostgREST rejects a
-- payload naming a column that doesn't exist, so the order matters.
alter table public.scores
  add column if not exists user_mins       integer check (user_mins is null or user_mins >= 0),
  add column if not exists optimal_mins    integer check (optimal_mins is null or optimal_mins >= 0),
  add column if not exists scoring_version integer check (scoring_version is null or scoring_version > 0);
