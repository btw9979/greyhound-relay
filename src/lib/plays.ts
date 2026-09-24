import type { SupabaseClient } from "@supabase/supabase-js";

export type GameType = "real" | "practice";
export type GameStatus = "in_progress" | "complete";
export type Mode = "OFFENSE" | "DEFENSE";

export interface Game {
  id: string;
  game_date: string;
  game_type: GameType;
  status: GameStatus;
  opponent: string | null;
  is_home: boolean | null;
  /** Which mode the game opens in before its first play — see startNewGame. */
  starting_mode: Mode | null;
  /** Null until End Game is confirmed; editable afterward from the EoG summary. */
  final_score_us: number | null;
  final_score_opponent: number | null;
  created_at: string;
}

// "P" marks the first play of a new drive exclusively — every later down
// within that drive is a concrete number, same as before.
export type Down = 1 | 2 | 3 | 4 | "P";
export type Personnel = "CLEAN" | "SHORT" | "OVER";
export type Flat = "SET" | "DEFENDER";
export type Splits = "NONE" | "FLANKER_TIGHT" | "SLOT_TIGHT" | "BOTH_TIGHT";
export type Formation = "OPEN" | "CLOSED";
export type Hash = "L" | "M" | "R";
export type Quarter = "Q1" | "Q2" | "Q3" | "Q4" | "OT";
export type ThreeTech = "FIELD" | "BOUNDARY" | "HEADS_UP";
export type ResultType =
  | "RUN"
  | "PASS_COMPLETE"
  | "PASS_INCOMPLETE"
  | "SACK"
  | "PENALTY"
  | "TURNOVER"
  | "SCORE"
  // Offense's failed pass attempt, picked off — counts as a pass attempt
  // (not a completion); see computeGameStats and the Turnover > INT flow.
  | "INTERCEPTION"
  // Marker row for an FG attempt (good or no good) — not a play. Replaces
  // the old workaround of logging FGs as a Turnover.
  | "FIELD_GOAL"
  // Marker row for a "no play" safety (Score > Safety > Other) — not a
  // play. A Run/Sack safety instead reuses RUN/SACK with negative yardage.
  | "SAFETY";
/** Which kind of play a touchdown was — see Play.score_play_type. */
export type ScorePlayType = "RUN" | "PASS_COMPLETE";

export type ScoringTeam = "us" | "opponent";
export type ScoreRecordType = "TD" | "FG" | "SAFETY";
/** How a TD happened — see the scores table's method column. */
export type ScoreMethod = "RUN" | "PASS" | "INT" | "FR" | "KR";
export type FgResult = "GOOD" | "NO_GOOD";
export type ConversionType = "PAT" | "TWO_POINT" | "NONE";
/** A PAT is always a kick; only a 2-point attempt has a method. */
export type ConversionMethod = "RUN" | "PASS";
export type ConversionResult = "GOOD" | "NO_GOOD";

/** Shared state common to both modes, plus exactly one mode's fields. */
export type OffenseState = {
  mode: "OFFENSE";
  flat: Flat;
  splits: Splits;
  formation: null;
};
export type DefenseState = {
  mode: "DEFENSE";
  formation: Formation;
  flat: null;
  splits: null;
};

export interface Play {
  id: string;
  game_id: string;
  drive_number: number;
  mode: Mode;
  down: Down;
  distance: number;
  field_position: number;
  personnel: Personnel;
  flat: Flat | null;
  splits: Splits | null;
  formation: Formation | null;
  hash: Hash | null;
  three_tech: ThreeTech | null;
  // Null only on rows predating this field (see migration 0011) — every
  // row written by this app always has a real value.
  quarter: Quarter | null;
  result_type: ResultType | null;
  result_yards: number | null;
  // Only set when result_type is 'SCORE' — which underlying play type the
  // touchdown actually was, for the EoG Rush/Pass breakdown. Null for every
  // other result_type.
  score_play_type: ScorePlayType | null;
  created_at: string;
  created_by: string | null;
}

/**
 * `down` is a Postgres `text` column (it has to hold "P" alongside the
 * numbered downs — see migration 0005), so a row freshly read back from
 * Supabase has it as a JSON string ("2"), not the number the rest of the
 * app treats it as. Within one continuous session that's never an issue —
 * `state.down` only ever gets its value from this app's own numeric
 * literals — but Booth's initial-load effect fetches the latest play row
 * straight from Supabase on every mount, including a mid-drive reload, and
 * assigns `p.down` directly into that same state. Left unnormalized, a
 * later `currentDown + 1` in applyRunOrPassResult would silently
 * string-concatenate ("2" + 1 = "21") instead of incrementing, producing a
 * down value the DB's check constraint would then reject. Every place a
 * Play row crosses the Supabase boundary should run it through this first.
 */
export function normalizePlayFromDb(row: Play): Play {
  return { ...row, down: row.down === "P" ? "P" : (Number(row.down) as 1 | 2 | 3 | 4) };
}

export const DEFAULT_DOWN = 1;
export const DEFAULT_DISTANCE = 10;
export const DEFAULT_PERSONNEL: Personnel = "CLEAN";
export const DEFAULT_FLAT: Flat = "SET";
export const DEFAULT_SPLITS: Splits = "NONE";
export const DEFAULT_FORMATION: Formation = "OPEN";
// Hash has no "normal" value the way Flat/Splits/Formation do — every snap
// needs a real, deliberately-tapped read, so this is only the initial
// selection shown before the booth taps anything.
export const DEFAULT_HASH: Hash = "M";
// Field is by far the most common 3-Tech alignment, so — unlike Hash — this
// is a real assumed-correct default: the booth only taps when it's Boundary
// or Heads-Up, same exception pattern as Personnel/Splits.
export const DEFAULT_THREE_TECH: ThreeTech = "FIELD";
export const DEFAULT_QUARTER: Quarter = "Q1";

/** Human-readable "Own 25" / "Opp 40" for a 1-99 yards-to-goal value. */
export function formatFieldPosition(fieldPosition: number): string {
  if (fieldPosition > 50) return `Own ${100 - fieldPosition}`;
  return `Opp ${fieldPosition}`;
}

/**
 * field_position is a fixed physical coordinate (yards to the opponent's
 * goal line, regardless of who has the ball) — but "yards to go" and
 * "goal-to-go" are always relative to whichever goal the CURRENT offense
 * is actually driving toward, which flips with mode. This reframes the
 * fixed coordinate into that attacking frame: on offense, Lisbon drives
 * toward the low end, so it's field_position directly; on defense, the
 * opponent drives toward the high end, so it's the complement.
 */
export function attackingFieldPosition(mode: Mode, fieldPosition: number): number {
  return mode === "OFFENSE" ? fieldPosition : 100 - fieldPosition;
}

export function formatDownDistance(
  mode: Mode,
  down: Down,
  distance: number,
  fieldPosition: number,
): string {
  // P is exclusively a first-play-of-drive marker — down is always 1, and P
  // always wins over Goal on that first play regardless of field position.
  // Goal-to-go logic only ever applies from the second play of a drive on.
  if (down === "P") return "1 & P";
  const label = ["", "1st", "2nd", "3rd", "4th"][down] ?? `${down}th`;
  if (distance <= 0) return `${label} & Goal`;
  const goalToGo = attackingFieldPosition(mode, fieldPosition) <= distance;
  return goalToGo ? `${label} & Goal` : `${label} & ${distance}`;
}

function clampFieldPosition(value: number): number {
  return Math.min(99, Math.max(1, value));
}

interface AutoCalcInput {
  mode: Mode;
  down: Down;
  distance: number;
  fieldPosition: number;
  gainYards: number;
}

interface AutoCalcResult {
  down: number;
  distance: number;
  fieldPosition: number;
  /** True on 4th-down failure to convert — the booth still needs to tap NEW DRIVE. */
  turnoverOnDowns: boolean;
}

/** Down/distance/field-position math for RUN, PASS_COMPLETE, and PASS_INCOMPLETE results. */
export function applyRunOrPassResult({
  mode,
  down,
  distance,
  fieldPosition,
  gainYards,
}: AutoCalcInput): AutoCalcResult {
  // "P" (opening play of a drive) behaves exactly like 1st down for this
  // math — the distinction is only ever about which play a drive started
  // on, not about down-to-down arithmetic.
  const currentDown = down === "P" ? 1 : down;

  // Do the yardage/goal-to-go math in the current offense's attacking
  // frame, then convert the result back to the fixed field_position
  // coordinate for storage.
  const attackingPosition = attackingFieldPosition(mode, fieldPosition);
  const newAttackingPosition = clampFieldPosition(attackingPosition - gainYards);
  const newFieldPosition =
    mode === "OFFENSE" ? newAttackingPosition : 100 - newAttackingPosition;
  const converted = gainYards >= distance;

  if (converted) {
    return {
      down: 1,
      distance: Math.min(DEFAULT_DISTANCE, newAttackingPosition),
      fieldPosition: newFieldPosition,
      turnoverOnDowns: false,
    };
  }

  if (currentDown < 4) {
    return {
      down: currentDown + 1,
      distance: distance - gainYards,
      fieldPosition: newFieldPosition,
      turnoverOnDowns: false,
    };
  }

  return {
    down: currentDown,
    distance: distance - gainYards,
    fieldPosition: newFieldPosition,
    turnoverOnDowns: true,
  };
}

function todaysLocalDate(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Games are no longer implied by calendar date — the booth explicitly
 * starts each one (see startNewGame) and picks real vs. practice, so
 * several can share a date. "Current" just means the most recently
 * started game; both roles follow whichever one that is.
 */
export async function getCurrentGame(supabase: SupabaseClient): Promise<Game | null> {
  const { data, error } = await supabase
    .from("games")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data as Game | null;
}

export interface NewGameSetup {
  gameType: GameType;
  opponent: string;
  isHome: boolean;
  /** Which team receives the opening kickoff, as an initial mode. */
  startingMode: Mode;
}

/** Booth-only action: explicitly starts a new game from the Game Setup Screen. */
export async function startNewGame(
  supabase: SupabaseClient,
  setup: NewGameSetup,
): Promise<Game> {
  const { data, error } = await supabase
    .from("games")
    .insert({
      game_date: todaysLocalDate(),
      game_type: setup.gameType,
      status: "in_progress",
      opponent: setup.opponent,
      is_home: setup.isHome,
      starting_mode: setup.startingMode,
    })
    .select("*")
    .single();

  if (error) throw error;
  return data as Game;
}

export interface FinalScore {
  us: number;
  opponent: number;
}

/** Booth-only action: ends the current game. Requires its own confirmation upstream. */
export async function endGame(
  supabase: SupabaseClient,
  gameId: string,
  finalScore: FinalScore,
): Promise<void> {
  const { error } = await supabase
    .from("games")
    .update({
      status: "complete",
      final_score_us: finalScore.us,
      final_score_opponent: finalScore.opponent,
    })
    .eq("id", gameId);

  if (error) throw error;
}

/** Corrects a final score already recorded by End Game, from the EoG summary. */
export async function updateFinalScore(
  supabase: SupabaseClient,
  gameId: string,
  finalScore: FinalScore,
): Promise<void> {
  const { error } = await supabase
    .from("games")
    .update({ final_score_us: finalScore.us, final_score_opponent: finalScore.opponent })
    .eq("id", gameId);

  if (error) throw error;
}

/**
 * One row per score (TD/FG/SAFETY) — see migration 0012. `play_id` is null
 * when no offensive play produced the score (a KR return, or the return
 * itself on an INT/FR return-for-TD — the underlying turnover attempt is a
 * separate, already-logged play). Conversion fields are null until
 * `updateScoreConversion` fills them in, a moment after the TD row is
 * created.
 */
export interface Score {
  id: string;
  game_id: string;
  play_id: string | null;
  quarter: Quarter;
  clock: string | null;
  scoring_team: ScoringTeam;
  score_type: ScoreRecordType;
  method: ScoreMethod | null;
  distance_yards: number | null;
  player_number: string | null;
  player_name: string | null;
  passer_number: string | null;
  passer_name: string | null;
  fg_result: FgResult | null;
  conversion_type: ConversionType | null;
  conversion_method: ConversionMethod | null;
  conversion_result: ConversionResult | null;
  conversion_player_number: string | null;
  conversion_player_name: string | null;
  conversion_passer_number: string | null;
  conversion_passer_name: string | null;
  created_at: string;
  created_by: string | null;
}

export interface NewScore {
  gameId: string;
  playId: string | null;
  quarter: Quarter;
  clock: string | null;
  scoringTeam: ScoringTeam;
  scoreType: ScoreRecordType;
  method?: ScoreMethod | null;
  distanceYards?: number | null;
  playerNumber?: string | null;
  playerName?: string | null;
  passerNumber?: string | null;
  passerName?: string | null;
  fgResult?: FgResult | null;
}

/** Booth-only: creates a score record. A TD's conversion is added afterward via updateScoreConversion. */
export async function insertScore(
  supabase: SupabaseClient,
  userId: string,
  score: NewScore,
): Promise<Score> {
  const { data, error } = await supabase
    .from("scores")
    .insert({
      game_id: score.gameId,
      play_id: score.playId,
      quarter: score.quarter,
      clock: score.clock,
      scoring_team: score.scoringTeam,
      score_type: score.scoreType,
      method: score.method ?? null,
      distance_yards: score.distanceYards ?? null,
      player_number: score.playerNumber ?? null,
      player_name: score.playerName ?? null,
      passer_number: score.passerNumber ?? null,
      passer_name: score.passerName ?? null,
      fg_result: score.fgResult ?? null,
      created_by: userId,
    })
    .select("*")
    .single();

  if (error) throw error;
  return data as Score;
}

export interface ScoreConversion {
  type: ConversionType;
  method?: ConversionMethod | null;
  result?: ConversionResult | null;
  playerNumber?: string | null;
  playerName?: string | null;
  passerNumber?: string | null;
  passerName?: string | null;
}

/** Booth-only: records the conversion attempt on an already-created TD score record. */
export async function updateScoreConversion(
  supabase: SupabaseClient,
  scoreId: string,
  conversion: ScoreConversion,
): Promise<void> {
  const { error } = await supabase
    .from("scores")
    .update({
      conversion_type: conversion.type,
      conversion_method: conversion.method ?? null,
      conversion_result: conversion.result ?? null,
      conversion_player_number: conversion.playerNumber ?? null,
      conversion_player_name: conversion.playerName ?? null,
      conversion_passer_number: conversion.passerNumber ?? null,
      conversion_passer_name: conversion.passerName ?? null,
    })
    .eq("id", scoreId);

  if (error) throw error;
}

/** All score records for a game, in logged order — the order the running score and scoring summary use. */
export async function getGameScores(supabase: SupabaseClient, gameId: string): Promise<Score[]> {
  const { data, error } = await supabase
    .from("scores")
    .select("*")
    .eq("game_id", gameId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data ?? []) as Score[];
}

export interface ScoreEdit {
  clock: string | null;
  method: ScoreMethod | null;
  distanceYards: number | null;
  playerNumber: string | null;
  playerName: string | null;
  passerNumber: string | null;
  passerName: string | null;
  conversionType: ConversionType | null;
  conversionMethod: ConversionMethod | null;
  conversionResult: ConversionResult | null;
  conversionPlayerNumber: string | null;
  conversionPlayerName: string | null;
  conversionPasserNumber: string | null;
  conversionPasserName: string | null;
}

/**
 * Booth-only: applies an edit to an existing score record — see Edit
 * Scoring. The caller is responsible for keeping fields consistent with
 * `scores_type_fields_check` (e.g. passing nulls for TD-only fields on an
 * FG/SAFETY record) and, if `method` changed on a Run/Pass TD, for also
 * calling `correctTdPlayType` — this function only ever touches `scores`.
 */
export async function updateScore(
  supabase: SupabaseClient,
  scoreId: string,
  edit: ScoreEdit,
): Promise<void> {
  const { error } = await supabase
    .from("scores")
    .update({
      clock: edit.clock,
      method: edit.method,
      distance_yards: edit.distanceYards,
      player_number: edit.playerNumber,
      player_name: edit.playerName,
      passer_number: edit.passerNumber,
      passer_name: edit.passerName,
      conversion_type: edit.conversionType,
      conversion_method: edit.conversionMethod,
      conversion_result: edit.conversionResult,
      conversion_player_number: edit.conversionPlayerNumber,
      conversion_player_name: edit.conversionPlayerName,
      conversion_passer_number: edit.conversionPasserNumber,
      conversion_passer_name: edit.conversionPasserName,
    })
    .eq("id", scoreId);

  if (error) throw error;
}

/**
 * Booth-only, narrowly-scoped correction (migration 0013): fixes a Run/Pass
 * TD's underlying play row when film shows it was logged as the wrong
 * type — result_type stays 'SCORE' (that's what drives the mode-flip/new-
 * drive behavior and must never change), only score_play_type flips. The
 * grant backing this only permits that one column, on rows that are
 * already a Run/Pass TD, so this can't be used to edit anything else.
 */
export async function correctTdPlayType(
  supabase: SupabaseClient,
  playId: string,
  scorePlayType: ScorePlayType,
): Promise<void> {
  const { error } = await supabase
    .from("plays")
    .update({ score_play_type: scorePlayType })
    .eq("id", playId);

  if (error) throw error;
}

/** Formats raw typed digits ("127") as mm:ss ("1:27") — see the Score flow's Time field. */
export function formatClockDigits(digits: string): string {
  const seconds = digits.slice(-2).padStart(2, "0");
  const minutes = digits.slice(0, -2);
  return `${minutes === "" ? "0" : minutes}:${seconds}`;
}

/** Converts raw typed digits to the value stored on a score record — empty input stays optional (null). */
export function clockValueForSubmit(digits: string): string | null {
  return digits === "" ? null : formatClockDigits(digits);
}

export interface RushingStats {
  attempts: number;
  /** Includes rushing-TD yardage (score_play_type = 'RUN' SCORE rows). */
  yards: number;
  yardsPerCarry: number | null;
  touchdowns: number;
}

export interface PassingStats {
  /** Includes passing-TD yardage (score_play_type = 'PASS_COMPLETE' SCORE rows). */
  yards: number;
  completions: number;
  /** Pass Complete + Pass Incomplete. */
  attempts: number;
  yardsPerCompletion: number | null;
  yardsPerAttempt: number | null;
  /** Grouped under Passing, not its own table — a sack is a failed passing play. */
  sackCount: number;
  /** Always <= 0 — signed the same way result_yards is stored. */
  sackYards: number;
  touchdowns: number;
  /** Interceptions thrown (offense) or made (defense) — see result_type 'INTERCEPTION'. */
  interceptions: number;
}

export interface TotalStats {
  /** Run + Pass Complete + Pass Incomplete + Sack — SCORE rows aren't counted as a distinct play here. */
  plays: number;
  firstDowns: number;
  thirdDownConversions: number;
  thirdDownAttempts: number;
  /** NFHS/NCAA "Total Offense"/"Total Defense": rushing.yards + passing.yards + passing.sackYards. */
  yards: number;
}

/** Team-level scrimmage stats for one side of the ball (offense or defense). */
export interface SideStats {
  rushing: RushingStats;
  passing: PassingStats;
  total: TotalStats;
}

export interface GameStats {
  offense: SideStats;
  defense: SideStats;
}

function emptySideStats(): SideStats {
  return {
    rushing: { attempts: 0, yards: 0, yardsPerCarry: null, touchdowns: 0 },
    passing: {
      yards: 0,
      completions: 0,
      attempts: 0,
      yardsPerCompletion: null,
      yardsPerAttempt: null,
      sackCount: 0,
      sackYards: 0,
      touchdowns: 0,
      interceptions: 0,
    },
    total: { plays: 0, firstDowns: 0, thirdDownConversions: 0, thirdDownAttempts: 0, yards: 0 },
  };
}

/**
 * A row's own `down` comes back from Postgres as text ('1'..'4'/'P') even
 * though the app's in-memory state treats it as a number — normalize
 * either representation, with "P" (always a drive's opening snap) as 1.
 */
function downAsNumber(down: Down | string): number {
  return down === "P" ? 1 : Number(down);
}

export interface PlayLogRow {
  mode: Mode;
  down: Down;
  result_type: ResultType | null;
  result_yards: number | null;
  score_play_type: ScorePlayType | null;
}

/**
 * Builds the EoG summary's Offense/Defense stat tables from the game's full
 * play log, which MUST be given in chronological order (oldest first) —
 * unlike the other stats here, 3rd Down Conversions depends on play
 * sequence, not just independent per-row totals.
 *
 * A row's own down/distance describe the state for the coming play, not
 * the down its own play was snapped on (that's what lets the live
 * Sideline screen show the upcoming presnap read) — so "was this play run
 * on 3rd down" has to be read off the *previous* row, tracked here as
 * `enteringDown`.
 *
 * A touchdown IS a real Run or Pass Complete play — score_play_type says
 * which — so besides its own TD tally, a SCORE row counts everywhere that
 * play type naturally would: Rushing Attempts or Completions, yardage,
 * Total Plays, First Downs (a score always gains one), and a 3rd Down
 * Conversion if it happened on 3rd down. A legacy SCORE row from before
 * score_play_type existed has it null and is excluded entirely, same as
 * before that distinction was tracked.
 *
 * INTERCEPTION counts as a pass attempt (not a completion) and as a play —
 * including toward 3rd Down Attempts — but never toward First Downs or a
 * 3rd Down Conversion: an interception is a turnover, so even though the
 * booth logs it with real down/distance math (via applyRunOrPassResult,
 * same as an incomplete pass), its own `down` field can only ever reflect
 * "didn't convert." FIELD_GOAL and a "no play" SAFETY are both excluded
 * entirely, same as a plain Turnover always has been. A Run/Sack safety
 * instead reuses RUN/SACK with negative yardage, so it's already covered
 * by the ordinary Rushing/Sack handling below — no special-casing needed.
 */
export function computeGameStats(plays: PlayLogRow[]): GameStats {
  const offense = emptySideStats();
  const defense = emptySideStats();

  // The down the *next* row's play will be snapped on, carried forward
  // from each row's own `down` field. Starts null; the very first row of
  // a game is always a new-drive marker (down = 'P'), so no real play is
  // ever attempted before one is seen.
  let enteringDown: Down | null = null;

  for (const row of plays) {
    const side = row.mode === "OFFENSE" ? offense : defense;
    const attemptedOn = enteringDown;
    enteringDown = row.down;

    if (row.result_type === null) continue;

    if (row.result_type === "SACK" && row.result_yards !== null) {
      side.passing.sackCount += 1;
      side.passing.sackYards += row.result_yards;
    }

    if (row.result_type === "INTERCEPTION") {
      side.passing.interceptions += 1;
    }

    const isScore = row.result_type === "SCORE";
    if (isScore && row.score_play_type === null) continue;

    const effectiveType = isScore ? row.score_play_type : row.result_type;

    if (isScore) {
      if (effectiveType === "RUN") side.rushing.touchdowns += 1;
      else side.passing.touchdowns += 1;
    }

    if (effectiveType === "RUN" && row.result_yards !== null) {
      side.rushing.yards += row.result_yards;
      side.rushing.attempts += 1;
    }
    if (effectiveType === "PASS_COMPLETE" && row.result_yards !== null) {
      side.passing.yards += row.result_yards;
      side.passing.completions += 1;
    }
    if (
      effectiveType === "PASS_COMPLETE" ||
      effectiveType === "PASS_INCOMPLETE" ||
      effectiveType === "INTERCEPTION"
    ) {
      side.passing.attempts += 1;
    }

    if (
      effectiveType === "RUN" ||
      effectiveType === "PASS_COMPLETE" ||
      effectiveType === "PASS_INCOMPLETE" ||
      effectiveType === "SACK" ||
      effectiveType === "INTERCEPTION"
    ) {
      side.total.plays += 1;
      if (attemptedOn !== null && downAsNumber(attemptedOn) === 3) {
        side.total.thirdDownAttempts += 1;
        // A score always converts; a score row's own `down` field isn't a
        // "next play" state (there is no next play in that drive), so a
        // real, non-score conversion instead needs the resulting down to
        // actually be 1.
        if (isScore || downAsNumber(row.down) === 1) side.total.thirdDownConversions += 1;
      }
    }

    if (isScore) {
      side.total.firstDowns += 1;
    } else if (
      (row.result_type === "RUN" ||
        row.result_type === "PASS_COMPLETE" ||
        row.result_type === "PASS_INCOMPLETE" ||
        row.result_type === "PENALTY") &&
      downAsNumber(row.down) === 1
    ) {
      side.total.firstDowns += 1;
    }
  }

  for (const side of [offense, defense]) {
    side.rushing.yardsPerCarry =
      side.rushing.attempts > 0 ? side.rushing.yards / side.rushing.attempts : null;
    side.passing.yardsPerCompletion =
      side.passing.completions > 0 ? side.passing.yards / side.passing.completions : null;
    side.passing.yardsPerAttempt =
      side.passing.attempts > 0 ? side.passing.yards / side.passing.attempts : null;
    side.total.yards = side.rushing.yards + side.passing.yards + side.passing.sackYards;
  }

  return { offense, defense };
}
