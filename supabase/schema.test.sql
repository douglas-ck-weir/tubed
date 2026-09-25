-- Verification script for schema.sql. Paste into the Supabase SQL editor and
-- run AFTER applying schema.sql. It wraps everything in a transaction and
-- rolls back at the end, so it leaves no rows behind.
--
-- Every check raises an exception on failure, so a clean run to the final
-- "ALL CHECKS PASSED" notice means the ranking maths, the UNIQUE guard and
-- the RLS policies all behave.

begin;

-- The fixture uses 1990 dates ON PURPOSE. An earlier version used real
-- calendar dates and collided with actual play data, which produced a
-- baffling "rank1: my_rank=3" — genuine fast solves on that date were
-- outranking the fixture. Nothing here may use a date the game can produce.
do $$
declare n int;
begin
  select count(*) into n from public.scores
   where puzzle_date between '1990-01-01' and '1990-12-31';
  if n > 0 then
    raise exception 'fixture dates are not empty (% rows in 1990) - the assertions below assume sole ownership of them', n;
  end if;
end $$;

-- Deterministic fixture: 10 players on one date/mode. Ordered by
-- (diff_mins asc, completion_secs asc, hints_used asc), so the expected
-- ranking is the order listed here.
insert into public.scores (puzzle_date, mode, player_id, diff_mins, completion_secs) values
  ('1990-01-01','easy','00000000-0000-0000-0000-000000000001', 0,  90),  -- rank 1
  ('1990-01-01','easy','00000000-0000-0000-0000-000000000002', 0, 120),  -- rank 2
  ('1990-01-01','easy','00000000-0000-0000-0000-000000000003', 1,  60),  -- rank 3
  ('1990-01-01','easy','00000000-0000-0000-0000-000000000004', 2, 100),  -- rank 4
  ('1990-01-01','easy','00000000-0000-0000-0000-000000000005', 3, 100),  -- rank 5
  ('1990-01-01','easy','00000000-0000-0000-0000-000000000006', 4, 100),  -- rank 6
  ('1990-01-01','easy','00000000-0000-0000-0000-000000000007', 5, 100),  -- rank 7
  ('1990-01-01','easy','00000000-0000-0000-0000-000000000008', 6, 100),  -- rank 8
  ('1990-01-01','easy','00000000-0000-0000-0000-000000000009', 7, 100),  -- rank 9
  ('1990-01-01','easy','00000000-0000-0000-0000-000000000010', 8, 100);  -- rank 10

-- A different mode on the same date must not bleed into easy's ranking.
insert into public.scores (puzzle_date, mode, player_id, diff_mins, completion_secs) values
  ('1990-01-01','hard','00000000-0000-0000-0000-0000000000a1', 0, 50),
  ('1990-01-01','hard','00000000-0000-0000-0000-0000000000a2', 9, 50);

do $$
declare r json; n int;
begin
  -- rank 1 of 10 -> top_pct 10, is_top3 true
  r := public.get_leaderboard_stats('1990-01-01','easy','00000000-0000-0000-0000-000000000001');
  if (r->>'my_rank')::int <> 1        then raise exception 'rank1: my_rank=% (want 1)',       r->>'my_rank'; end if;
  if (r->>'top_pct')::int <> 10       then raise exception 'rank1: top_pct=% (want 10)',      r->>'top_pct'; end if;
  if (r->>'is_top3')::bool is not true then raise exception 'rank1: is_top3=% (want true)',   r->>'is_top3'; end if;
  if (r->>'total_players')::int <> 10 then raise exception 'rank1: total=% (want 10 - hard mode must not leak)', r->>'total_players'; end if;

  -- tiebreak: same diff, slower time -> rank 2 (NOT tied with rank 1)
  r := public.get_leaderboard_stats('1990-01-01','easy','00000000-0000-0000-0000-000000000002');
  if (r->>'my_rank')::int <> 2 then raise exception 'tiebreak: my_rank=% (want 2 - completion_secs must break the diff tie)', r->>'my_rank'; end if;

  -- rank 3 is still a podium, rank 4 is not
  r := public.get_leaderboard_stats('1990-01-01','easy','00000000-0000-0000-0000-000000000003');
  if (r->>'is_top3')::bool is not true then raise exception 'rank3: is_top3 should be true'; end if;
  r := public.get_leaderboard_stats('1990-01-01','easy','00000000-0000-0000-0000-000000000004');
  if (r->>'is_top3')::bool is not false then raise exception 'rank4: is_top3 should be false'; end if;

  -- last place -> top_pct 100 (the client hides anything over 50)
  r := public.get_leaderboard_stats('1990-01-01','easy','00000000-0000-0000-0000-000000000010');
  if (r->>'top_pct')::int <> 100 then raise exception 'last: top_pct=% (want 100)', r->>'top_pct'; end if;

  -- a player with no row -> null rank, false podium, but a real total
  r := public.get_leaderboard_stats('1990-01-01','easy','00000000-0000-0000-0000-0000000000ff');
  if r->>'my_rank' is not null        then raise exception 'absent: my_rank should be null, got %', r->>'my_rank'; end if;
  if (r->>'is_top3')::bool is not false then raise exception 'absent: is_top3 should be false'; end if;
  if (r->>'total_players')::int <> 10 then raise exception 'absent: total=% (want 10)', r->>'total_players'; end if;

  -- a date nobody played -> zero, and no exception / no empty result set
  r := public.get_leaderboard_stats('1999-01-01','easy','00000000-0000-0000-0000-000000000001');
  if r is null                       then raise exception 'empty date returned NULL instead of a json object'; end if;
  if (r->>'total_players')::int <> 0 then raise exception 'empty date: total=% (want 0)', r->>'total_players'; end if;

  -- identical on diff, time AND hints is a genuine tie: they share a rank
  insert into public.scores (puzzle_date, mode, player_id, diff_mins, completion_secs, hints_used) values
    ('1990-01-02','easy','00000000-0000-0000-0000-0000000000b1', 0, 80, 0),
    ('1990-01-02','easy','00000000-0000-0000-0000-0000000000b2', 0, 80, 0);
  r := public.get_leaderboard_stats('1990-01-02','easy','00000000-0000-0000-0000-0000000000b1');
  if (r->>'my_rank')::int <> 1 then raise exception 'tie: b1 rank=% (want 1)', r->>'my_rank'; end if;
  r := public.get_leaderboard_stats('1990-01-02','easy','00000000-0000-0000-0000-0000000000b2');
  if (r->>'my_rank')::int <> 1 then raise exception 'tie: b2 rank=% (want 1 - all three equal is a real tie)', r->>'my_rank'; end if;

  -- hints_used breaks a tie on diff AND time: fewer hints ranks higher
  insert into public.scores (puzzle_date, mode, player_id, diff_mins, completion_secs, hints_used) values
    ('1990-01-06','easy','00000000-0000-0000-0000-0000000000c8', 0, 70, 2),
    ('1990-01-06','easy','00000000-0000-0000-0000-0000000000c9', 0, 70, 0);
  r := public.get_leaderboard_stats('1990-01-06','easy','00000000-0000-0000-0000-0000000000c9');
  if (r->>'my_rank')::int <> 1 then
    raise exception 'hint tiebreak: the no-hint player ranked % (want 1)', r->>'my_rank';
  end if;
  r := public.get_leaderboard_stats('1990-01-06','easy','00000000-0000-0000-0000-0000000000c8');
  if (r->>'my_rank')::int <> 2 then
    raise exception 'hint tiebreak: the 2-hint player ranked % (want 2)', r->>'my_rank';
  end if;

  -- ...but hints must stay BELOW time. A no-hint player who was slower still
  -- loses to a hinted player who was faster.
  insert into public.scores (puzzle_date, mode, player_id, diff_mins, completion_secs, hints_used) values
    ('1990-01-07','easy','00000000-0000-0000-0000-0000000000d8', 0, 60, 3),
    ('1990-01-07','easy','00000000-0000-0000-0000-0000000000d9', 0, 95, 0);
  r := public.get_leaderboard_stats('1990-01-07','easy','00000000-0000-0000-0000-0000000000d8');
  if (r->>'my_rank')::int <> 1 then
    raise exception 'hint precedence: the faster 3-hint player ranked % (want 1 - hints rank BELOW time)', r->>'my_rank';
  end if;

  -- median time-to-optimal. The 1990-01-01 fixture has exactly two optimal
  -- solvers (diff 0) at 90s and 120s, so the median is their midpoint.
  r := public.get_leaderboard_stats('1990-01-01','easy','00000000-0000-0000-0000-000000000001');
  if (r->>'optimal_count')::int <> 2 then
    raise exception 'median: optimal_count=% (want 2 - only diff_mins=0 rows count)', r->>'optimal_count';
  end if;
  if (r->>'median_optimal_secs')::int <> 105 then
    raise exception 'median: got % (want 105 = midpoint of 90 and 120)', r->>'median_optimal_secs';
  end if;

  -- a day with no optimal solver at all must not invent an anchor
  insert into public.scores (puzzle_date, mode, player_id, diff_mins, completion_secs) values
    ('1990-01-04','easy','00000000-0000-0000-0000-0000000000e1', 4, 100),
    ('1990-01-04','easy','00000000-0000-0000-0000-0000000000e2', 9, 100);
  r := public.get_leaderboard_stats('1990-01-04','easy','00000000-0000-0000-0000-0000000000e1');
  if (r->>'optimal_count')::int <> 0     then raise exception 'no-optimal day: optimal_count=% (want 0)', r->>'optimal_count'; end if;
  if r->>'median_optimal_secs' is not null then raise exception 'no-optimal day: median should be null, got %', r->>'median_optimal_secs'; end if;

  -- odd count takes the middle value, not an average
  insert into public.scores (puzzle_date, mode, player_id, diff_mins, completion_secs) values
    ('1990-01-05','easy','00000000-0000-0000-0000-0000000000f1', 0,  60),
    ('1990-01-05','easy','00000000-0000-0000-0000-0000000000f2', 0, 100),
    ('1990-01-05','easy','00000000-0000-0000-0000-0000000000f3', 0, 140);
  r := public.get_leaderboard_stats('1990-01-05','easy','00000000-0000-0000-0000-0000000000f1');
  if (r->>'median_optimal_secs')::int <> 100 then
    raise exception 'odd-count median: got % (want 100)', r->>'median_optimal_secs';
  end if;

  -- the whole point of median over mean: one abandoned tab must not move it.
  -- Adding a 2-hour entry to the three above shifts the mean to ~1875s but
  -- the median only to 120.
  insert into public.scores (puzzle_date, mode, player_id, diff_mins, completion_secs)
  values ('1990-01-05','easy','00000000-0000-0000-0000-0000000000f4', 0, 7200);
  r := public.get_leaderboard_stats('1990-01-05','easy','00000000-0000-0000-0000-0000000000f1');
  if (r->>'median_optimal_secs')::int > 200 then
    raise exception 'outlier moved the median to % - is this a mean rather than a median?', r->>'median_optimal_secs';
  end if;

  -- non-optimal players must not pollute the anchor
  insert into public.scores (puzzle_date, mode, player_id, diff_mins, completion_secs)
  values ('1990-01-05','easy','00000000-0000-0000-0000-0000000000f5', 15, 1);
  r := public.get_leaderboard_stats('1990-01-05','easy','00000000-0000-0000-0000-0000000000f1');
  if (r->>'optimal_count')::int <> 4 then
    raise exception 'anchor: optimal_count=% (want 4 - a 15-min-off solve must not count)', r->>'optimal_count';
  end if;

  -- top_pct must never be 0: rank 1 of a large field floors to 1
  insert into public.scores (puzzle_date, mode, player_id, diff_mins, completion_secs)
  select '1990-01-03','easy', ('00000000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, g, 100
  from generate_series(1, 300) g;
  r := public.get_leaderboard_stats('1990-01-03','easy','00000000-0000-0000-0000-000000000001');
  if (r->>'top_pct')::int <> 1 then raise exception 'floor: rank 1 of 300 gave top_pct=% (want 1, never 0)', r->>'top_pct'; end if;

  -- Analytics columns must accept a full row...
  insert into public.scores (puzzle_date, mode, player_id, diff_mins, completion_secs,
                             user_mins, optimal_mins, scoring_version)
  values ('1990-01-01','easy','00000000-0000-0000-0000-0000000000a9', 4, 150, 32, 28, 9);

  -- ...and must still accept a row that omits them, so a stale cached client
  -- can never be silently kept off the board by a NOT NULL violation.
  insert into public.scores (puzzle_date, mode, player_id, diff_mins, completion_secs)
  values ('1990-01-01','easy','00000000-0000-0000-0000-0000000000aa', 4, 150);
  if (select count(*) from public.scores
        where player_id = '00000000-0000-0000-0000-0000000000aa'
          and user_mins is null and scoring_version is null) <> 1 then
    raise exception 'analytics columns: an omitted-column insert did not land as NULL';
  end if;

  -- but nonsense values are still rejected
  begin
    insert into public.scores (puzzle_date, mode, player_id, diff_mins, completion_secs, user_mins)
    values ('1990-01-01','easy','00000000-0000-0000-0000-0000000000ab', 4, 150, -3);
    raise exception 'CHECK failed: negative user_mins was allowed';
  exception when check_violation then null; end;

  -- UNIQUE guard: the same player cannot land a second (better) score
  begin
    insert into public.scores (puzzle_date, mode, player_id, diff_mins, completion_secs)
    values ('1990-01-01','easy','00000000-0000-0000-0000-000000000010', 0, 1);
    raise exception 'UNIQUE guard failed: a duplicate (date, mode, player) insert was allowed';
  exception when unique_violation then
    null; -- expected
  end;

  -- CHECK guards
  begin
    insert into public.scores (puzzle_date, mode, player_id, diff_mins, completion_secs)
    values ('1990-01-01','easy','00000000-0000-0000-0000-0000000000c1', -5, 100);
    raise exception 'CHECK failed: negative diff_mins was allowed';
  exception when check_violation then null; end;

  begin
    insert into public.scores (puzzle_date, mode, player_id, diff_mins, completion_secs)
    values ('1990-01-01','easy','00000000-0000-0000-0000-0000000000c2', 0, 99999);
    raise exception 'CHECK failed: absurd completion_secs was allowed';
  exception when check_violation then null; end;

  begin
    insert into public.scores (puzzle_date, mode, player_id, diff_mins, completion_secs)
    values ('1990-01-01','medium','00000000-0000-0000-0000-0000000000c3', 0, 100);
    raise exception 'CHECK failed: an unknown mode was allowed';
  exception when check_violation then null; end;

  raise notice 'function + constraint checks passed';
end $$;

-- ---------------------------------------------------------------------------
-- RLS, exercised as the anon role the browser actually uses.
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  set local role anon;

  -- today's date is insertable
  insert into public.scores (puzzle_date, mode, player_id, diff_mins, completion_secs)
  values ((now() at time zone 'Europe/London')::date, 'easy',
          '00000000-0000-0000-0000-0000000000d1', 3, 200);

  -- a future date must be refused by the policy
  begin
    insert into public.scores (puzzle_date, mode, player_id, diff_mins, completion_secs)
    values ((now() at time zone 'Europe/London')::date + 7, 'easy',
            '00000000-0000-0000-0000-0000000000d2', 0, 100);
    raise exception 'RLS failed: a future-dated score was accepted';
  exception when insufficient_privilege then null; end;

  -- an old date must be refused too (no backfilling last week's board)
  begin
    insert into public.scores (puzzle_date, mode, player_id, diff_mins, completion_secs)
    values ((now() at time zone 'Europe/London')::date - 30, 'easy',
            '00000000-0000-0000-0000-0000000000d3', 0, 100);
    raise exception 'RLS failed: a 30-day-old score was accepted';
  exception when insufficient_privilege then null; end;

  -- anon must not be able to read raw rows (that would leak every player_id).
  -- Two acceptable outcomes: no SELECT grant at all (permission denied), or a
  -- grant that RLS filters down to nothing. Both mean the data is not exposed.
  begin
    select count(*) into n from public.scores;
    if n <> 0 then
      raise exception 'RLS failed: anon read % raw rows (want 0 - reads must go through the function)', n;
    end if;
  exception when insufficient_privilege then
    null; -- no grant at all: stronger than RLS filtering, so this passes
  end;

  -- ...but the aggregate function is still callable as anon
  if public.get_leaderboard_stats('1990-01-01','easy','00000000-0000-0000-0000-000000000001') is null then
    raise exception 'anon could not call get_leaderboard_stats';
  end if;

  reset role;
  raise notice 'RLS checks passed';
end $$;

do $$ begin raise notice 'ALL CHECKS PASSED'; end $$;

rollback;
