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

/** Booth-only action: ends the current game. Requires its own confirmation upstream. */
export async function endGame(supabase: SupabaseClient, gameId: string): Promise<void> {
  const { error } = await supabase
    .from("games")
    .update({ status: "complete" })
    .eq("id", gameId);

  if (error) throw error;
}
