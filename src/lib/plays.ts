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
export type ThreeTech = "FIELD" | "BOUNDARY" | "HEADS_UP";
export type ResultType =
  | "RUN"
  | "PASS_COMPLETE"
  | "PASS_INCOMPLETE"
  | "SACK"
  | "PENALTY"
  | "TURNOVER"
  | "SCORE";
/** Which kind of play a touchdown was — see Play.score_play_type. */
export type ScorePlayType = "RUN" | "PASS_COMPLETE";

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
  result_type: ResultType | null;
  result_yards: number | null;
  // Only set when result_type is 'SCORE' — which underlying play type the
  // touchdown actually was, for the EoG Rush/Pass breakdown. Null for every
  // other result_type.
  score_play_type: ScorePlayType | null;
  created_at: string;
  created_by: string | null;
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
    if (effectiveType === "PASS_COMPLETE" || effectiveType === "PASS_INCOMPLETE") {
      side.passing.attempts += 1;
    }

    if (
      effectiveType === "RUN" ||
      effectiveType === "PASS_COMPLETE" ||
      effectiveType === "PASS_INCOMPLETE" ||
      effectiveType === "SACK"
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
