"""Tests for the diff comparison logic."""

from build_interchanges import diff as diff_mod


def test_matches_when_values_equal():
    game = {'A': {'X|Y': 3}}
    api = {'A': {'X|Y': 3}}
    report = diff_mod.compute_diff(game, api)
    assert len(report.matches) == 1
    assert report.matches[0] == ('A', 'X|Y', 3, 3)


def test_small_change_within_threshold():
    game = {'A': {'X|Y': 3}}
    api = {'A': {'X|Y': 4}}
    report = diff_mod.compute_diff(game, api, small_change_threshold=1)
    assert len(report.small_changes) == 1
    assert not report.big_changes


def test_big_change_outside_threshold():
    game = {'A': {'X|Y': 3}}
    api = {'A': {'X|Y': 8}}
    report = diff_mod.compute_diff(game, api, small_change_threshold=1)
    assert len(report.big_changes) == 1
    assert not report.small_changes


def test_missing_pair():
    game = {'A': {'X|Y': 3}}
    api = {'A': {}}
    report = diff_mod.compute_diff(game, api)
    assert len(report.missing_pairs) == 1
    assert report.missing_pairs[0] == ('A', 'X|Y', 3)


def test_new_pair():
    game = {'A': {}}
    api = {'A': {'X|Y': 3}}
    report = diff_mod.compute_diff(game, api)
    assert len(report.new_pairs) == 1


def test_same_line_missing_flagged_as_missing():
    """Same-line X|X pairs in the game but not produced by the API should
    surface as MISSING — branch-split pairs (Whitechapel Elizabeth↔Elizabeth,
    Woodford Central↔Central) are real game interchanges and must not be
    silently dropped.
    """
    game = {'A': {'Central|Central': 1}}
    api = {'A': {}}
    report = diff_mod.compute_diff(game, api)
    assert len(report.missing_pairs) == 1
    assert report.missing_pairs[0] == ('A', 'Central|Central', 1)


def test_is_clean_only_when_no_big_or_missing():
    game = {'A': {'X|Y': 3, 'P|Q': 5}}
    api = {'A': {'X|Y': 3, 'P|Q': 6}}  # small change only
    report = diff_mod.compute_diff(game, api)
    assert report.is_clean

    api2 = {'A': {'X|Y': 3}}  # missing P|Q
    report2 = diff_mod.compute_diff(game, api2)
    assert not report2.is_clean
