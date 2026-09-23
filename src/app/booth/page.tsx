"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  applyRunOrPassResult,
  attackingFieldPosition,
  clockValueForSubmit,
  computeGameStats,
  endGame,
  formatClockDigits,
  formatDownDistance,
  formatFieldPosition,
  getCurrentGame,
  insertScore,
  normalizePlayFromDb,
  startNewGame,
  updateScoreConversion,
  DEFAULT_DISTANCE,
  DEFAULT_DOWN,
  DEFAULT_FLAT,
  DEFAULT_FORMATION,
  DEFAULT_HASH,
  DEFAULT_PERSONNEL,
  DEFAULT_QUARTER,
  DEFAULT_SPLITS,
  DEFAULT_THREE_TECH,
} from "@/lib/plays";
import type {
  ConversionMethod,
  ConversionResult,
  Down,
  FgResult,
  Flat,
  Formation,
  Game,
  GameStats,
  GameType,
  Hash,
  Mode,
  Personnel,
  Play,
  PlayLogRow,
  Quarter,
  ResultType,
  ScoreConversion,
  ScoreMethod,
  ScorePlayType,
  ScoringTeam,
  Splits,
  ThreeTech,
} from "@/lib/plays";
import { SwitchRole } from "@/components/SwitchRole";
import { Sheet } from "@/components/Sheet";
import { ExceptionToggle } from "@/components/ExceptionToggle";
import { StatBreakdown } from "@/components/StatBreakdown";

type TapStatus = "idle" | "sending" | "sent" | "error";

/**
 * What the shared TD details/conversion steps need to know but don't
 * themselves collect: which method, who scored, the play this TD is linked
 * to (if any, for `scores.play_id`), and the mode/field position to hand
 * `triggerAutoNewDrive` once the whole TD — details and conversion — is
 * done. See section 4 of the scoring-capture plan.
 */
interface PendingTd {
  method: ScoreMethod;
  scoringTeam: ScoringTeam;
  playId: string | null;
  distance: number | null;
  // Field position at the moment of the score — triggerAutoNewDrive's
  // SCORE kind actually ignores this (always a touchback), but it's kept
  // for the function's shared signature. Deliberately no `fromMode` here:
  // for a Run/Pass TD the scoring team is whoever was on offense, but for
  // KR/INT/FR it's the *other* side, so `fromMode` is derived from
  // `scoringTeam` at the point of use (see modeForScoringTeam) rather than
  // captured here, where it would be easy to get backwards.
  fromFieldPosition: number;
}

interface GameState {
  driveNumber: number;
  mode: Mode;
  down: Down;
  distance: number;
  fieldPosition: number;
  personnel: Personnel;
  flat: Flat;
  splits: Splits;
  formation: Formation;
  hash: Hash;
  threeTech: ThreeTech;
  quarter: Quarter;
}

function ToggleRow<T extends string>({
  label,
  value,
  options,
  onSelect,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; text: string; clean: boolean }[];
  onSelect: (v: T) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-400">
        {label}
      </p>
      <div className="grid grid-cols-2 gap-3">
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(opt.value)}
              className={[
                "rounded-2xl px-4 py-6 text-xl font-bold transition-colors disabled:opacity-50",
                active
                  ? opt.clean
                    ? "bg-emerald-500 text-emerald-950 ring-4 ring-emerald-300"
                    : "bg-red-500 text-red-950 ring-4 ring-red-300"
                  : "bg-slate-800 text-slate-300 active:bg-slate-700",
              ].join(" ")}
            >
              {opt.text}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Neutral 3-way selector for presnap reads with no "normal" value (Hash,
 * 3-Tech) — every option is equally valid, so unlike ToggleRow there's no
 * clean/alert coloring, just a single active highlight.
 */
function SelectRow<T extends string>({
  label,
  value,
  options,
  onSelect,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; text: string }[];
  onSelect: (v: T) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-400">
        {label}
      </p>
      <div className="grid grid-cols-3 gap-3">
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(opt.value)}
              className={[
                "rounded-2xl px-2 py-6 text-lg font-bold transition-colors disabled:opacity-50",
                active
                  ? "bg-slate-100 text-slate-900"
                  : "bg-slate-800 text-slate-300 active:bg-slate-700",
              ].join(" ")}
            >
              {opt.text}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Standard touchback yard line — the receiving team's own 25, per NFHS/NCAA
// convention. Which fp value that maps to depends on which team receives;
// see triggerAutoNewDrive.
const TOUCHBACK_YARD_LINE = 25;

const RESULT_LABELS: Record<ResultType, string> = {
  RUN: "Run",
  PASS_COMPLETE: "Pass Complete",
  PASS_INCOMPLETE: "Pass Incomplete",
  SACK: "Sack",
  PENALTY: "Penalty",
  TURNOVER: "Turnover",
  SCORE: "TD",
  INTERCEPTION: "Interception",
  FIELD_GOAL: "Field Goal",
  SAFETY: "Safety",
};

export default function BoothPage() {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [game, setGame] = useState<Game | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [status, setStatus] = useState<TapStatus>("idle");

  const [state, setState] = useState<GameState | null>(null);
  // True from a confirmed halftime (End Q2) until the second-half kickoff
  // drive is actually started — forces the same start-of-drive screen a
  // brand-new game shows, even though `state` already holds Q2's last play.
  const [awaitingSecondHalf, setAwaitingSecondHalf] = useState(false);
  const [pendingMode, setPendingMode] = useState<Mode>("OFFENSE");
  // The mode a new drive should switch to when triggered via the
  // OFFENSE/DEFENSE toggle, a Turnover/Score result, or turnover on downs;
  // null for a manually-selected P (new drive, mode unchanged).
  const [pendingDriveMode, setPendingDriveMode] = useState<Mode | null>(null);
  // Set only for the automatic Turnover/Score triggers, which compute their
  // own default (flip the turnover spot, or a touchback for a score)
  // instead of the generic "reuse current field position" default.
  const [pendingFieldPositionOverride, setPendingFieldPositionOverride] = useState<number | null>(
    null,
  );

  const [sheet, setSheet] = useState<
    | "newDrive"
    | "result"
    | "manageGame"
    | "gameSetup"
    | "endGameConfirm"
    | "confirmModeSwitch"
    | "confirmFieldPosition"
    // Score > TD/FG/Safety (section 2-6 of the scoring-capture plan)
    | "score"
    | "scoreTdMethod"
    | "scoreTdKrTeam"
    | "scoreTdDetails"
    | "scoreTdConversion"
    | "scoreTdConversionPat"
    | "scoreTdConversionTwoPoint"
    | "scoreFgResult"
    | "scoreFgDetails"
    | "scoreSafetyMethod"
    | "scoreSafetyDetails"
    // Turnover > INT/Fumble/Punt/Other (section 7)
    | "turnoverType"
    | "turnoverFumblePlay"
    | "turnoverReturnedForTd"
    | null
  >(null);
  const [newDriveField, setNewDriveField] = useState("");

  const [setupGameType, setSetupGameType] = useState<GameType>("real");
  const [setupOpponent, setSetupOpponent] = useState("");
  const [setupHomeAway, setSetupHomeAway] = useState<"home" | "away">("home");
  const [setupReceiving, setSetupReceiving] = useState<"us" | "opponent">("us");

  const [endGameScoreUs, setEndGameScoreUs] = useState("");
  const [endGameScoreOpponent, setEndGameScoreOpponent] = useState("");

  // On-demand mid-game stats snapshot ("Live Stats") — a quick look at the
  // same Offense/Defense breakdown the EoG summary shows, computed from
  // whatever's been logged so far. Purely a read: never touches game.status
  // or any play-logging state.
  const [liveStatsOpen, setLiveStatsOpen] = useState(false);
  const [liveStats, setLiveStats] = useState<GameStats | null>(null);
  const [liveStatsLoading, setLiveStatsLoading] = useState(false);

  const [pendingResult, setPendingResult] = useState<ResultType | "END_QUARTER" | null>(null);
  const [yardageSign, setYardageSign] = useState<1 | -1>(1);
  const [yardageMagnitude, setYardageMagnitude] = useState("0");
  const [penaltyDown, setPenaltyDown] = useState(String(DEFAULT_DOWN));
  const [penaltyDistance, setPenaltyDistance] = useState("10");
  const [penaltyFieldPosition, setPenaltyFieldPosition] = useState("50");

  // TD details + conversion (section 4) — shared by every TD path: Run/Pass
  // (immediate), KR, and INT/FR returns (section 7). `pendingTd` holds what
  // the details/conversion steps need to know but don't themselves collect:
  // which method, who scored, the play this TD is linked to (if any), and
  // the mode/field position to hand to triggerAutoNewDrive once the whole
  // TD — details and conversion both — is done.
  const [pendingTd, setPendingTd] = useState<PendingTd | null>(null);
  const [tdTime, setTdTime] = useState("");
  const [tdPlayerNumber, setTdPlayerNumber] = useState("");
  const [tdPlayerName, setTdPlayerName] = useState("");
  const [tdPasserNumber, setTdPasserNumber] = useState("");
  const [tdPasserName, setTdPasserName] = useState("");
  const [tdReturnDistance, setTdReturnDistance] = useState("");
  // The just-created scores row — set once the details step submits, so the
  // conversion step (a separate UPDATE) knows which row to amend.
  const [pendingScoreId, setPendingScoreId] = useState<string | null>(null);

  const [conversionMethod, setConversionMethod] = useState<ConversionMethod>("RUN");
  const [conversionPlayerNumber, setConversionPlayerNumber] = useState("");
  const [conversionPlayerName, setConversionPlayerName] = useState("");
  const [conversionPasserNumber, setConversionPasserNumber] = useState("");
  const [conversionPasserName, setConversionPasserName] = useState("");

  const [fgResult, setFgResult] = useState<FgResult>("GOOD");
  const [fgDistance, setFgDistance] = useState("");
  const [fgTime, setFgTime] = useState("");
  const [fgKickerNumber, setFgKickerNumber] = useState("");
  const [fgKickerName, setFgKickerName] = useState("");

  const [safetyTime, setSafetyTime] = useState("");
  const [safetyTacklerNumber, setSafetyTacklerNumber] = useState("");
  const [safetyTacklerName, setSafetyTacklerName] = useState("");

  const [turnoverFumblePlayType, setTurnoverFumblePlayType] = useState<"RUN" | "PASS_COMPLETE">(
    "RUN",
  );
  const [turnoverFumbleYards, setTurnoverFumbleYards] = useState("0");
  // Which turnover produced the current "Returned for a TD?" prompt — only
  // INT and Fumble offer it; Punt/Other never reach this state.
  const [turnoverReturnMethod, setTurnoverReturnMethod] = useState<"INT" | "FR" | null>(null);

  // Bridges a Run/Sack/Other safety's underlying play (or lack of one) to
  // the details step and, from there, to the post-safety new-drive handoff.
  const [pendingSafety, setPendingSafety] = useState<{
    playId: string | null;
    fromMode: Mode;
    fromFieldPosition: number;
  } | null>(null);

  const [krTeam, setKrTeam] = useState<ScoringTeam>("us");

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      try {
        const currentGame = await getCurrentGame(supabase);
        if (cancelled) return;
        setUserId(user.id);

        if (!currentGame) return;
        setGame(currentGame);

        const { data: latest } = await supabase
          .from("plays")
          .select("*")
          .eq("game_id", currentGame.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (cancelled) return;

        if (!latest) {
          // No play logged yet for this game — reflect the mode chosen at
          // setup (who received the opening kickoff) rather than defaulting
          // to OFFENSE, so a reload before the first drive still shows it.
          if (currentGame.starting_mode) setPendingMode(currentGame.starting_mode);
        } else {
          const p = normalizePlayFromDb(latest as Play);
          setPendingMode(p.mode);
          setState({
            driveNumber: p.drive_number,
            mode: p.mode,
            down: p.down,
            distance: p.distance,
            fieldPosition: p.field_position,
            personnel: p.personnel,
            flat: p.flat ?? DEFAULT_FLAT,
            splits: p.splits ?? DEFAULT_SPLITS,
            formation: p.formation ?? DEFAULT_FORMATION,
            hash: p.hash ?? DEFAULT_HASH,
            threeTech: p.three_tech ?? DEFAULT_THREE_TECH,
            quarter: p.quarter ?? DEFAULT_QUARTER,
          });
        }
      } catch {
        if (!cancelled) {
          setInitError("Couldn't reach the server. Check connection and reload.");
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [supabase]);

  // Returns the inserted row's id (so scoring flows can link a scores row
  // to the play that produced it via play_id), or null on failure.
  const insert = useCallback(
    async (
      next: GameState,
      result: { type: ResultType; yards: number | null; scorePlayType?: ScorePlayType } | null,
    ): Promise<string | null> => {
      if (!game || !userId) return null;
      setStatus("sending");
      const { data, error } = await supabase
        .from("plays")
        .insert({
          game_id: game.id,
          created_by: userId,
          drive_number: next.driveNumber,
          mode: next.mode,
          down: next.down,
          distance: next.distance,
          field_position: next.fieldPosition,
          personnel: next.personnel,
          flat: next.mode === "OFFENSE" ? next.flat : null,
          splits: next.mode === "OFFENSE" ? next.splits : null,
          formation: next.mode === "DEFENSE" ? next.formation : null,
          hash: next.mode === "OFFENSE" ? next.hash : null,
          three_tech: next.mode === "OFFENSE" ? next.threeTech : null,
          quarter: next.quarter,
          result_type: result?.type ?? null,
          result_yards: result?.yards ?? null,
          score_play_type: result?.scorePlayType ?? null,
        })
        .select("id")
        .single();
      setStatus(error ? "error" : "sent");
      if (!error) {
        setTimeout(() => setStatus((s) => (s === "sent" ? "idle" : s)), 1500);
      }
      return error ? null : (data as { id: string }).id;
    },
    [game, userId, supabase],
  );

  // Play-logging controls are only ever live for a game that's actually
  // in progress — a completed game (or no game at all) leaves everything
  // visibly disabled, whether that's a fresh load or an "End Game" that
  // just happened.
  const inProgressGame = game?.status === "in_progress" ? game : null;
  const disabled = !ready || !inProgressGame || status === "sending";

  function updateAndSend(patch: Partial<GameState>) {
    if (!state) return;
    const next = { ...state, ...patch };
    setState(next);
    insert(next, null);
  }

  function openGameSetup() {
    setSetupGameType("real");
    setSetupOpponent("");
    setSetupHomeAway("home");
    setSetupReceiving("us");
    setSheet("gameSetup");
  }

  async function submitGameSetup() {
    const opponent = setupOpponent.trim();
    if (!opponent) return;
    const startingMode: Mode = setupReceiving === "us" ? "OFFENSE" : "DEFENSE";
    try {
      const newGame = await startNewGame(supabase, {
        gameType: setupGameType,
        opponent,
        isHome: setupHomeAway === "home",
        startingMode,
      });
      setGame(newGame);
      setState(null);
      setAwaitingSecondHalf(false);
      setPendingMode(startingMode);
      resetDriveFlow();
      setSheet(null);
      setInitError(null);
    } catch {
      setInitError("Couldn't start the game. Check connection and try again.");
    }
  }

  function openEndGameConfirm() {
    setEndGameScoreUs("");
    setEndGameScoreOpponent("");
    setSheet("endGameConfirm");
  }

  async function confirmEndGame() {
    if (!game) return;
    const us = Number(endGameScoreUs);
    const opponent = Number(endGameScoreOpponent);
    if (!Number.isInteger(us) || us < 0 || !Number.isInteger(opponent) || opponent < 0) return;
    try {
      await endGame(supabase, game.id, { us, opponent });
      setGame({ ...game, status: "complete", final_score_us: us, final_score_opponent: opponent });
      setSheet(null);
    } catch {
      setInitError("Couldn't end the game. Check connection and try again.");
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  // computeGameStats needs chronological order — 3rd Down Conversions
  // depends on play sequence, not just independent per-row totals. Same
  // query shape as the Sideline EoG summary's fetch, just invoked on demand
  // instead of gated on game.status === "complete".
  async function openLiveStats() {
    if (!game) return;
    setLiveStatsOpen(true);
    setLiveStatsLoading(true);
    const { data } = await supabase
      .from("plays")
      .select("mode, down, result_type, result_yards, score_play_type")
      .eq("game_id", game.id)
      .order("created_at", { ascending: true });
    setLiveStats(data ? computeGameStats(data as PlayLogRow[]) : null);
    setLiveStatsLoading(false);
  }

  // Writes a state-only row (result_type null, like updateAndSend) tagging
  // the new quarter — never touches down/distance/field position/drive/
  // mode. Awaited (unlike updateAndSend's fire-and-forget) so callers can
  // gate what happens next (closing the sheet, opening the halftime kickoff
  // screen) on the write actually succeeding.
  async function advanceQuarter(newQuarter: Quarter): Promise<boolean> {
    if (!state) return false;
    const next: GameState = { ...state, quarter: newQuarter };
    const id = await insert(next, null);
    if (id) setState(next);
    return !!id;
  }

  function closeEndQuarter() {
    setSheet(null);
    setPendingResult(null);
  }

  // End of Q1/Q3: advance the tag only — the current drive continues
  // unchanged (see plan section 3: teams switch ends, but field_position is
  // relative to the opponent's goal, not a physical side, so nothing else
  // needs to change).
  async function confirmEndQuarterAdvance(nextQuarter: Quarter) {
    const ok = await advanceQuarter(nextQuarter);
    if (ok) closeEndQuarter();
  }

  // Halftime: advance to Q3, then hand off to the same start-of-drive
  // screen a brand-new game shows (see the awaitingSecondHalf branch below)
  // — replaces the old workaround of logging a Turnover to flip possession.
  async function confirmHalftime() {
    const ok = await advanceQuarter("Q3");
    if (!ok) return;
    closeEndQuarter();
    // The team that received the opening kickoff normally kicks off to
    // start the second half — preselect the opposite mode, but leave it
    // changeable (the kicking team can still end up with the ball).
    setPendingMode(game?.starting_mode === "OFFENSE" ? "DEFENSE" : "OFFENSE");
    setAwaitingSecondHalf(true);
  }

  async function confirmStartOvertime() {
    const ok = await advanceQuarter("OT");
    if (ok) closeEndQuarter();
  }

  // All overtime periods share the same "OT" tag — nothing to write, just
  // dismiss the prompt.
  function confirmContinueOvertime() {
    closeEndQuarter();
  }

  function goToEndGameFromQuarter() {
    setPendingResult(null);
    openEndGameConfirm();
  }

  // The mode the about-to-start drive will use: a pending switch if one is
  // underway (toggle, Turnover/Score, or turnover on downs), otherwise the
  // current state's mode — or, before any drive has ever started (or during
  // the halftime kickoff screen, which reuses that same bootstrap UI),
  // whatever's selected on the mode toggle.
  const effectiveMode =
    state && !awaitingSecondHalf ? pendingDriveMode ?? state.mode : pendingMode;

  // field_position is a fixed physical coordinate — yards from the actual
  // opponent's goal line — independent of which team currently has the
  // ball (formatFieldPosition takes no mode/team argument, which is the
  // tell). A mode switch or turnover doesn't move the ball, so it never
  // transforms this number; only Score does, via its own explicit
  // touchback override below (see triggerAutoNewDrive), since a score's
  // kickoff genuinely does relocate the ball.
  const defaultFieldPosition =
    pendingFieldPositionOverride !== null
      ? pendingFieldPositionOverride
      : state
        ? state.fieldPosition
        : null;

  function resetDriveFlow() {
    setPendingDriveMode(null);
    setPendingFieldPositionOverride(null);
  }

  function openManualFieldPosition(prefill: number | null) {
    setNewDriveField(prefill === null ? "" : String(prefill));
    setSheet("newDrive");
  }

  // Manual P selection: available at all times (first drive of the game,
  // first drive of the second half, or correcting a missed auto-trigger).
  // Unlike the toggle/Turnover/Score paths, this never changes mode on its
  // own — the mode is assumed to already be correct.
  function selectManualP() {
    resetDriveFlow();
    // No previous play to default from yet — either the very first drive of
    // the game, or the second-half kickoff, where the last-known field
    // position (from end of Q2) isn't a meaningful default. Both go
    // straight to manual entry, same as the start of a game.
    if (!state || awaitingSecondHalf) {
      openManualFieldPosition(null);
      return;
    }
    setSheet("confirmFieldPosition");
  }

  function requestModeSwitch(mode: Mode) {
    if (!state || mode === state.mode) return;
    resetDriveFlow();
    setPendingDriveMode(mode);
    setSheet("confirmModeSwitch");
  }

  function cancelDriveFlow() {
    resetDriveFlow();
    setSheet(null);
  }

  function confirmModeSwitch() {
    setSheet("confirmFieldPosition");
  }

  // Turnover/Score always mean both a mode switch and a new drive — no
  // "continue?" prompt, straight to the field-position default/override
  // step. Also used for turnover on downs, which is the same event (loss
  // of possession) even though it isn't the "Turnover" result button.
  function triggerAutoNewDrive(fromMode: Mode, fromFieldPosition: number, kind: "TURNOVER" | "SCORE") {
    const newMode: Mode = fromMode === "OFFENSE" ? "DEFENSE" : "OFFENSE";
    setPendingDriveMode(newMode);
    setPendingFieldPositionOverride(
      kind === "SCORE"
        ? // Touchback = the receiving team's own 25. Which team that is
          // depends on the new mode: OFFENSE means Lisbon receives (Own
          // 25 = fp 75); DEFENSE means the opponent receives (Opp 25 =
          // fp 25) — this isn't the same fp regardless of direction.
          newMode === "OFFENSE"
          ? 100 - TOUCHBACK_YARD_LINE
          : TOUCHBACK_YARD_LINE
        : // A turnover doesn't move the ball — same fixed spot, unchanged.
          fromFieldPosition,
    );
    setSheet("confirmFieldPosition");
  }

  async function commitNewDrive(fieldPosition: number) {
    const next: GameState = {
      driveNumber: (state?.driveNumber ?? 0) + 1,
      mode: effectiveMode,
      down: "P",
      // Goal-to-go suggestion needs the new offense's attacking distance,
      // not the raw fixed coordinate — those only match when mode is
      // OFFENSE.
      distance: Math.min(DEFAULT_DISTANCE, attackingFieldPosition(effectiveMode, fieldPosition)),
      fieldPosition,
      personnel: DEFAULT_PERSONNEL,
      flat: DEFAULT_FLAT,
      splits: DEFAULT_SPLITS,
      formation: DEFAULT_FORMATION,
      hash: DEFAULT_HASH,
      threeTech: DEFAULT_THREE_TECH,
      // Starting a drive never changes the quarter on its own — carries
      // forward whatever's current (already bumped to Q3 by confirmHalftime
      // before this screen ever shows, for the second-half kickoff case).
      quarter: state?.quarter ?? DEFAULT_QUARTER,
    };
    const id = await insert(next, null);
    if (id) {
      setState(next);
      setSheet(null);
      resetDriveFlow();
      setAwaitingSecondHalf(false);
    }
    return !!id;
  }

  function acceptDefaultFieldPosition() {
    if (defaultFieldPosition === null) return;
    commitNewDrive(defaultFieldPosition);
  }

  async function submitNewDrive() {
    const fp = Number(newDriveField);
    if (!Number.isInteger(fp) || fp < 1 || fp > 99) return;
    await commitNewDrive(fp);
  }

  function openResult() {
    setPendingResult(null);
    setYardageSign(1);
    setYardageMagnitude("0");
    if (state) {
      // A penalty can happen on the 1 & P play itself — fall back to a
      // real number rather than prefilling the literal "P".
      setPenaltyDown(state.down === "P" ? String(DEFAULT_DOWN) : String(state.down));
      setPenaltyDistance(String(state.distance));
      setPenaltyFieldPosition(String(state.fieldPosition));
    }
    setSheet("result");
  }

  // Returns the inserted play's id (or null on failure) — SCORE-type
  // callers need it to link a scores row via play_id, so unlike the
  // boolean helpers above this hands back the id itself; truthiness still
  // works for callers that only care whether the write succeeded.
  async function submitResult(
    type: ResultType,
    yards: number | null,
    overrides?: Partial<GameState>,
    scorePlayType?: ScorePlayType,
  ): Promise<string | null> {
    if (!state) return null;
    const next: GameState = {
      ...state,
      ...overrides,
      personnel: DEFAULT_PERSONNEL,
      flat: DEFAULT_FLAT,
      splits: DEFAULT_SPLITS,
      formation: DEFAULT_FORMATION,
      hash: DEFAULT_HASH,
      threeTech: DEFAULT_THREE_TECH,
    };
    const id = await insert(next, { type, yards, scorePlayType });
    if (!id) return null;
    setState(next);
    setSheet(null);
    setPendingResult(null);

    // A plain Turnover (Punt/Other) unambiguously means a mode switch and a
    // new drive — no confirmation prompt, straight to the field-position
    // step. SCORE (always a Run/Pass TD now — see submitScore) instead
    // waits for the TD details/conversion flow to finish before triggering
    // the same handoff.
    if (type === "TURNOVER") {
      triggerAutoNewDrive(next.mode, next.fieldPosition, type);
    }
    return id;
  }

  function submitRunOrPass(type: "RUN" | "PASS_COMPLETE" | "SACK") {
    if (!state) return;
    const fromMode = state.mode;
    // A sack can't be a gain — enforced here regardless of yardageSign so a
    // stale toggle state (the Gain/Loss buttons aren't even shown for SACK)
    // can never submit a positive value.
    const sign = type === "SACK" ? -1 : yardageSign;
    const gain = Number(yardageMagnitude) * sign;
    if (!Number.isFinite(gain)) return;
    const calc = applyRunOrPassResult({
      mode: state.mode,
      down: state.down,
      distance: state.distance,
      fieldPosition: state.fieldPosition,
      gainYards: gain,
    });
    submitResult(type, gain, {
      down: calc.down as 1 | 2 | 3 | 4,
      distance: calc.distance,
      fieldPosition: calc.fieldPosition,
    }).then((ok) => {
      // Turnover on downs is the same loss-of-possession event as the
      // Turnover result button, just reached via a failed 4th-down play.
      if (ok && calc.turnoverOnDowns) {
        triggerAutoNewDrive(fromMode, calc.fieldPosition, "TURNOVER");
      }
    });
  }

  function submitPassIncomplete() {
    if (!state) return;
    const fromMode = state.mode;
    const calc = applyRunOrPassResult({
      mode: state.mode,
      down: state.down,
      distance: state.distance,
      fieldPosition: state.fieldPosition,
      gainYards: 0,
    });
    submitResult("PASS_INCOMPLETE", 0, {
      down: calc.down as 1 | 2 | 3 | 4,
      distance: calc.distance,
      fieldPosition: calc.fieldPosition,
    }).then((ok) => {
      if (ok && calc.turnoverOnDowns) {
        triggerAutoNewDrive(fromMode, calc.fieldPosition, "TURNOVER");
      }
    });
  }

  // Team currently on offense, as a scores.scoring_team value.
  function offenseTeam(mode: Mode): ScoringTeam {
    return mode === "OFFENSE" ? "us" : "opponent";
  }
  function defenseTeam(mode: Mode): ScoringTeam {
    return mode === "OFFENSE" ? "opponent" : "us";
  }
  // Inverse of offenseTeam — the mode the scoring team would be "on
  // offense" in, which is what triggerAutoNewDrive needs as fromMode (the
  // team about to kick off is always whoever just scored, regardless of
  // whether they were on offense or defense for the play that produced it).
  function modeForScoringTeam(team: ScoringTeam): Mode {
    return team === "us" ? "OFFENSE" : "DEFENSE";
  }

  function openTdDetails(pending: PendingTd) {
    setPendingTd(pending);
    setPendingScoreId(null);
    setTdTime("");
    setTdPlayerNumber("");
    setTdPlayerName("");
    setTdPasserNumber("");
    setTdPasserName("");
    setTdReturnDistance("");
    setSheet("scoreTdDetails");
  }

  // Run/Pass TD (Score > TD > Run/Pass) — unchanged mechanically from
  // before this update (same yardage calc, same rushing/passing stat
  // attribution via the existing SCORE/score_play_type handling); the only
  // difference is that the post-TD new-drive handoff now waits for the
  // details/conversion flow instead of firing immediately.
  async function submitScoreRunOrPass(scorePlayType: ScorePlayType) {
    if (!state) return;
    const fromMode = state.mode;
    const fromFieldPosition = state.fieldPosition;
    // A score is a real scrimmage play covering a real distance — from the
    // current spot to the goal line — not just a drive-ending event with
    // no yardage, unlike Turnover/Penalty. Computed the same way P & Goal
    // is: the current offense's attacking-frame distance to the goal.
    const yards = attackingFieldPosition(state.mode, state.fieldPosition);
    const playId = await submitResult("SCORE", yards, undefined, scorePlayType);
    if (!playId) return;
    openTdDetails({
      method: scorePlayType === "RUN" ? "RUN" : "PASS",
      scoringTeam: offenseTeam(fromMode),
      playId,
      distance: yards,
      fromFieldPosition,
    });
  }

  function submitPenalty() {
    const down = Number(penaltyDown);
    const distance = Number(penaltyDistance);
    const fp = Number(penaltyFieldPosition);
    if (!Number.isInteger(down) || down < 1 || down > 4) return;
    if (!Number.isInteger(distance) || distance < 0) return;
    if (!Number.isInteger(fp) || fp < 1 || fp > 99) return;
    submitResult("PENALTY", null, { down: down as 1 | 2 | 3 | 4, distance, fieldPosition: fp });
  }

  // ---- Scoring capture (Score > TD/FG/Safety, Turnover > INT/Fumble) ----
  //
  // Shared ground rule across every path below: once the underlying play
  // (if any) is actually logged, nothing in the details/conversion forms
  // that follow may block the booth from moving on to the next snap — a
  // failed detail/conversion save shows initError but still proceeds
  // straight to the post-score new-drive handoff. See the plan's "must not
  // slow down live data entry" requirement.

  async function finishConversion(conversion: ScoreConversion) {
    if (!pendingTd) return;
    if (pendingScoreId) {
      try {
        await updateScoreConversion(supabase, pendingScoreId, conversion);
      } catch {
        setInitError("Couldn't save the conversion. Check connection and try again.");
      }
    }
    const { scoringTeam, fromFieldPosition } = pendingTd;
    setPendingTd(null);
    setPendingScoreId(null);
    setSheet(null);
    triggerAutoNewDrive(modeForScoringTeam(scoringTeam), fromFieldPosition, "SCORE");
  }

  function submitConversionNone() {
    finishConversion({ type: "NONE" });
  }

  function submitConversionPat(result: ConversionResult) {
    finishConversion({
      type: "PAT",
      result,
      playerNumber: conversionPlayerNumber || null,
      playerName: conversionPlayerName || null,
    });
  }

  function submitConversionTwoPoint(result: ConversionResult) {
    finishConversion({
      type: "TWO_POINT",
      method: conversionMethod,
      result,
      playerNumber: conversionPlayerNumber || null,
      playerName: conversionPlayerName || null,
      passerNumber: conversionMethod === "PASS" ? conversionPasserNumber || null : null,
      passerName: conversionMethod === "PASS" ? conversionPasserName || null : null,
    });
  }

  async function submitTdDetails() {
    if (!pendingTd || !state || !userId || !game) return;
    const distance =
      pendingTd.distance !== null
        ? pendingTd.distance
        : tdReturnDistance === ""
          ? null
          : Number(tdReturnDistance);
    try {
      const score = await insertScore(supabase, userId, {
        gameId: game.id,
        playId: pendingTd.playId,
        quarter: state.quarter,
        clock: clockValueForSubmit(tdTime),
        scoringTeam: pendingTd.scoringTeam,
        scoreType: "TD",
        method: pendingTd.method,
        distanceYards: distance,
        playerNumber: tdPlayerNumber || null,
        playerName: tdPlayerName || null,
        passerNumber: pendingTd.method === "PASS" ? tdPasserNumber || null : null,
        passerName: pendingTd.method === "PASS" ? tdPasserName || null : null,
      });
      setPendingScoreId(score.id);
      setConversionMethod("RUN");
      setConversionPlayerNumber("");
      setConversionPlayerName("");
      setConversionPasserNumber("");
      setConversionPasserName("");
      setSheet("scoreTdConversion");
    } catch {
      setInitError("Couldn't save the score. Check connection and try again.");
      const { scoringTeam, fromFieldPosition } = pendingTd;
      setPendingTd(null);
      setSheet(null);
      triggerAutoNewDrive(modeForScoringTeam(scoringTeam), fromFieldPosition, "SCORE");
    }
  }

  // KR (kickoff/punt returned for a TD) — no offensive play is recorded.
  function openScoreTdKr() {
    if (!state) return;
    // A drive with no logged plays yet (down still "P") is almost always a
    // kickoff return; anything past that is almost always a punt return.
    setKrTeam(state.down === "P" ? offenseTeam(state.mode) : defenseTeam(state.mode));
    setSheet("scoreTdKrTeam");
  }

  function submitScoreTdKr() {
    if (!state) return;
    openTdDetails({
      method: "KR",
      scoringTeam: krTeam,
      playId: null,
      distance: null,
      fromFieldPosition: state.fieldPosition,
    });
  }

  function openScoreFg() {
    setFgResult("GOOD");
    setSheet("scoreFgResult");
  }

  function chooseFgResult(result: FgResult) {
    if (!state) return;
    setFgResult(result);
    // Line of scrimmage to the goal the offense is attacking, plus the
    // standard 17-yard allowance (10 for the end zone + 7 for the snap).
    setFgDistance(String(attackingFieldPosition(state.mode, state.fieldPosition) + 17));
    setFgTime("");
    setFgKickerNumber("");
    setFgKickerName("");
    setSheet("scoreFgDetails");
  }

  async function submitFgDetails() {
    if (!state || !userId || !game) return;
    const distance = Number(fgDistance);
    if (!Number.isInteger(distance) || distance < 0) return;
    // Not a play: down/distance/field position carry over unchanged, same
    // as the marker row a plain Turnover writes.
    const playId = await submitResult("FIELD_GOAL", null);
    if (!playId) return;
    try {
      await insertScore(supabase, userId, {
        gameId: game.id,
        playId,
        quarter: state.quarter,
        clock: clockValueForSubmit(fgTime),
        scoringTeam: offenseTeam(state.mode),
        scoreType: "FG",
        distanceYards: distance,
        playerNumber: fgKickerNumber || null,
        playerName: fgKickerName || null,
        fgResult,
      });
    } catch {
      setInitError("Couldn't save the score. Check connection and try again.");
    }
    // Both outcomes flip possession the same way a plain Turnover does —
    // fixed spot, unchanged, adjustable on the field-position prompt.
    triggerAutoNewDrive(state.mode, state.fieldPosition, "TURNOVER");
  }

  function openScoreSafety() {
    setSheet("scoreSafetyMethod");
  }

  async function chooseSafetyMethod(method: "RUN" | "SACK" | "OTHER") {
    if (!state) return;
    const fromMode = state.mode;
    let playId: string | null;
    let fromFieldPosition: number;

    if (method === "OTHER") {
      // Not a play: down/distance/field position unchanged, no yardage.
      playId = await submitResult("SAFETY", null);
      fromFieldPosition = state.fieldPosition;
    } else {
      // Loss from the line of scrimmage back to the goal line the offense
      // is defending — attackingFieldPosition gives the distance to the
      // goal it's ATTACKING, so the defended goal is the complement of that.
      const safetyYards = attackingFieldPosition(state.mode, state.fieldPosition) - 100;
      const calc = applyRunOrPassResult({
        mode: state.mode,
        down: state.down,
        distance: state.distance,
        fieldPosition: state.fieldPosition,
        gainYards: safetyYards,
      });
      playId = await submitResult(method, safetyYards, {
        down: calc.down as 1 | 2 | 3 | 4,
        distance: calc.distance,
        fieldPosition: calc.fieldPosition,
      });
      fromFieldPosition = calc.fieldPosition;
    }

    if (!playId) return;
    setPendingSafety({ playId, fromMode, fromFieldPosition });
    setSafetyTime("");
    setSafetyTacklerNumber("");
    setSafetyTacklerName("");
    setSheet("scoreSafetyDetails");
  }

  async function submitSafetyDetails() {
    if (!pendingSafety || !userId || !game) return;
    try {
      await insertScore(supabase, userId, {
        gameId: game.id,
        playId: pendingSafety.playId,
        quarter: state?.quarter ?? DEFAULT_QUARTER,
        clock: clockValueForSubmit(safetyTime),
        scoringTeam: defenseTeam(pendingSafety.fromMode),
        scoreType: "SAFETY",
        playerNumber: safetyTacklerNumber || null,
        playerName: safetyTacklerName || null,
      });
    } catch {
      setInitError("Couldn't save the score. Check connection and try again.");
    }
    const { fromMode, fromFieldPosition } = pendingSafety;
    setPendingSafety(null);
    setSheet(null);
    // A safety's free kick flips possession to the scoring team, same
    // touchback-style default as any other score.
    triggerAutoNewDrive(fromMode, fromFieldPosition, "SCORE");
  }

  // Turnover > INT/Fumble/Punt/Other (section 7).

  async function chooseTurnoverInt() {
    if (!state) return;
    // Behaves like an incomplete pass for down/distance purposes (0 yards,
    // down advances, no first down) — the turnover then takes effect at
    // whatever spot that leaves the ball, same as any other turnover.
    const calc = applyRunOrPassResult({
      mode: state.mode,
      down: state.down,
      distance: state.distance,
      fieldPosition: state.fieldPosition,
      gainYards: 0,
    });
    const playId = await submitResult("INTERCEPTION", 0, {
      down: calc.down as 1 | 2 | 3 | 4,
      distance: calc.distance,
      fieldPosition: calc.fieldPosition,
    });
    if (!playId) return;
    setTurnoverReturnMethod("INT");
    setSheet("turnoverReturnedForTd");
  }

  function openTurnoverFumble() {
    setTurnoverFumblePlayType("RUN");
    setTurnoverFumbleYards("0");
    setSheet("turnoverFumblePlay");
  }

  async function submitTurnoverFumble() {
    if (!state) return;
    const raw = turnoverFumbleYards.trim();
    const yards = raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(yards)) return;
    const calc = applyRunOrPassResult({
      mode: state.mode,
      down: state.down,
      distance: state.distance,
      fieldPosition: state.fieldPosition,
      gainYards: yards,
    });
    const playId = await submitResult(turnoverFumblePlayType, yards, {
      down: calc.down as 1 | 2 | 3 | 4,
      distance: calc.distance,
      fieldPosition: calc.fieldPosition,
    });
    if (!playId) return;
    setTurnoverReturnMethod("FR");
    setSheet("turnoverReturnedForTd");
  }

  function submitTurnoverPuntOrOther() {
    submitResult("TURNOVER", null);
  }

  function turnoverReturnedForTd(yes: boolean) {
    if (!state || !turnoverReturnMethod) return;
    if (!yes) {
      setTurnoverReturnMethod(null);
      // triggerAutoNewDrive sets its own sheet ("confirmFieldPosition") as
      // its last step — no separate setSheet(null) here, which would only
      // clobber that in the same render batch.
      triggerAutoNewDrive(state.mode, state.fieldPosition, "TURNOVER");
      return;
    }
    const method = turnoverReturnMethod;
    setTurnoverReturnMethod(null);
    openTdDetails({
      method,
      scoringTeam: defenseTeam(state.mode),
      playId: null,
      distance: null,
      fromFieldPosition: state.fieldPosition,
    });
  }

  if (!state || awaitingSecondHalf) {
    return (
      <main className="flex flex-1 flex-col gap-8 p-5">
        <header className="flex items-center justify-between">
          <h1 className="text-lg font-bold text-slate-50">Booth</h1>
          <div className="flex items-center gap-3">
            <LiveStatsButton onClick={openLiveStats} disabled={!game} />
            <ManageGameButton onClick={() => setSheet("manageGame")} />
            <SwitchRole current="booth" />
          </div>
        </header>

        {game?.game_type === "practice" && <PracticeBanner />}

        {initError && (
          <p className="rounded-xl bg-red-950 px-4 py-3 text-sm text-red-300">{initError}</p>
        )}

        <div className="flex flex-1 flex-col items-center justify-center gap-6">
          {!inProgressGame && (
            <p className="text-sm font-semibold uppercase tracking-widest text-slate-400">
              No active game — use Manage Game to start one
            </p>
          )}
          {awaitingSecondHalf && (
            <p className="text-sm font-semibold uppercase tracking-widest text-amber-400">
              Halftime — start the second half
            </p>
          )}
          <ModeToggle mode={pendingMode} onChange={setPendingMode} disabled={disabled} />
          <button
            type="button"
            disabled={disabled}
            onClick={selectManualP}
            className="rounded-2xl bg-sky-600 px-8 py-6 text-2xl font-bold text-white active:bg-sky-700 disabled:opacity-50"
          >
            START DRIVE (1 &amp; P)
          </button>
        </div>

        {sheet === "newDrive" && (
          <NewDriveSheet
            fieldPosition={newDriveField}
            setFieldPosition={setNewDriveField}
            onClose={() => setSheet(null)}
            onSubmit={submitNewDrive}
          />
        )}

        {sheet === "manageGame" && (
          <ManageGameSheet
            inProgress={!!inProgressGame}
            onClose={() => setSheet(null)}
            onNewGame={openGameSetup}
            onEndGame={openEndGameConfirm}
            onLogout={handleLogout}
          />
        )}

        {sheet === "gameSetup" && (
          <GameSetupSheet
            gameType={setupGameType}
            setGameType={setSetupGameType}
            opponent={setupOpponent}
            setOpponent={setSetupOpponent}
            homeAway={setupHomeAway}
            setHomeAway={setSetupHomeAway}
            receiving={setupReceiving}
            setReceiving={setSetupReceiving}
            onClose={() => setSheet(null)}
            onSubmit={submitGameSetup}
          />
        )}

        {sheet === "endGameConfirm" && (
          <EndGameConfirmSheet
            scoreUs={endGameScoreUs}
            setScoreUs={setEndGameScoreUs}
            scoreOpponent={endGameScoreOpponent}
            setScoreOpponent={setEndGameScoreOpponent}
            onClose={() => setSheet(null)}
            onConfirm={confirmEndGame}
          />
        )}

        {liveStatsOpen && (
          <LiveStatsOverlay
            stats={liveStats}
            loading={liveStatsLoading}
            onClose={() => setLiveStatsOpen(false)}
          />
        )}
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col gap-6 p-5">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-slate-50">Booth</h1>
        <div className="flex items-center gap-3">
          <StatusPill status={status} />
          <LiveStatsButton onClick={openLiveStats} disabled={!game} />
          <ManageGameButton onClick={() => setSheet("manageGame")} />
          <SwitchRole current="booth" />
        </div>
      </header>

      {game?.game_type === "practice" && <PracticeBanner />}

      {initError && (
        <p className="rounded-xl bg-red-950 px-4 py-3 text-sm text-red-300">{initError}</p>
      )}

      <div className="flex items-center justify-between rounded-xl bg-slate-900 px-4 py-3 text-sm text-slate-300">
        <span>{state.quarter}</span>
        <span>Drive {state.driveNumber}</span>
        <span>{formatDownDistance(state.mode, state.down, state.distance, state.fieldPosition)}</span>
        <span>{formatFieldPosition(state.fieldPosition)}</span>
      </div>

      <ModeToggle mode={state.mode} disabled={disabled} onChange={requestModeSwitch} />

      <button
        type="button"
        disabled={disabled}
        onClick={selectManualP}
        className="rounded-xl bg-slate-800 px-4 py-3 text-sm font-semibold text-slate-300 active:bg-slate-700 disabled:opacity-50"
      >
        NEW DRIVE (1 &amp; P)
      </button>

      <ExceptionToggle
        label="Personnel"
        value={state.personnel}
        defaultValue={DEFAULT_PERSONNEL}
        defaultText="11 on field"
        flagText="⚠ COUNT ISSUE"
        disabled={disabled}
        onSelect={(v) => updateAndSend({ personnel: v })}
        options={[
          { value: "SHORT", text: "SHORT (≤10)", severity: "alert" },
          { value: "OVER", text: "OVER (12+)", severity: "urgent" },
        ]}
      />

      {state.mode === "OFFENSE" ? (
        <>
          <ToggleRow
            label="Flat"
            value={state.flat}
            disabled={disabled}
            onSelect={(v) => updateAndSend({ flat: v })}
            options={[
              { value: "SET", text: "CLEAR", clean: true },
              { value: "DEFENDER", text: "DEFENDER", clean: false },
            ]}
          />
          <ExceptionToggle
            label="Splits"
            value={state.splits}
            defaultValue={DEFAULT_SPLITS}
            defaultText="Correct"
            flagText="⚠ SPLITS ISSUE"
            disabled={disabled}
            onSelect={(v) => updateAndSend({ splits: v })}
            options={[
              { value: "FLANKER_TIGHT", text: "FLANKER TIGHT", severity: "alert" },
              { value: "SLOT_TIGHT", text: "SLOT TIGHT", severity: "alert" },
              { value: "BOTH_TIGHT", text: "BOTH TIGHT", severity: "alert" },
            ]}
          />
          <SelectRow
            label="Hash"
            value={state.hash}
            disabled={disabled}
            onSelect={(v) => updateAndSend({ hash: v })}
            options={[
              { value: "L", text: "L" },
              { value: "M", text: "M" },
              { value: "R", text: "R" },
            ]}
          />
          <ExceptionToggle
            label="3-Tech"
            value={state.threeTech}
            defaultValue={DEFAULT_THREE_TECH}
            defaultText="Field"
            flagText="⚠ 3-TECH ALIGN"
            disabled={disabled}
            onSelect={(v) => updateAndSend({ threeTech: v })}
            options={[
              { value: "BOUNDARY", text: "Boundary", severity: "alert" },
              { value: "HEADS_UP", text: "Heads-Up", severity: "alert" },
            ]}
          />
        </>
      ) : (
        <ToggleRow
          label="Formation"
          value={state.formation}
          disabled={disabled}
          onSelect={(v) => updateAndSend({ formation: v })}
          options={[
            { value: "OPEN", text: "OPEN", clean: true },
            { value: "CLOSED", text: "CLOSED", clean: false },
          ]}
        />
      )}

      <button
        type="button"
        disabled={disabled}
        onClick={openResult}
        className="mt-auto rounded-2xl bg-indigo-600 px-4 py-6 text-2xl font-bold text-white active:bg-indigo-700 disabled:opacity-50"
      >
        RESULT
      </button>

      {sheet === "newDrive" && (
        <NewDriveSheet
          fieldPosition={newDriveField}
          setFieldPosition={setNewDriveField}
          onClose={cancelDriveFlow}
          onSubmit={submitNewDrive}
        />
      )}

      {sheet === "confirmModeSwitch" && pendingDriveMode && (
        <Sheet title="Switch Mode" onClose={cancelDriveFlow}>
          <div className="flex flex-col gap-4">
            <p className="text-lg text-slate-200">
              Switching to <span className="font-bold">{pendingDriveMode}</span> will start Drive{" "}
              <span className="font-bold">{state.driveNumber + 1}</span> at{" "}
              <span className="font-bold">1 &amp; P</span>. Continue?
            </p>
            <button
              type="button"
              onClick={confirmModeSwitch}
              className="rounded-xl bg-indigo-600 px-4 py-4 text-lg font-bold text-white active:bg-indigo-700"
            >
              Continue
            </button>
            <button
              type="button"
              onClick={cancelDriveFlow}
              className="rounded-xl bg-slate-800 px-4 py-4 text-lg font-semibold text-slate-300 active:bg-slate-700"
            >
              Cancel
            </button>
          </div>
        </Sheet>
      )}

      {sheet === "confirmFieldPosition" && defaultFieldPosition !== null && (
        <Sheet title="New Drive" onClose={cancelDriveFlow}>
          <div className="flex flex-col gap-4">
            <p className="text-lg text-slate-200">
              Start new drive at{" "}
              <span className="font-bold">{formatFieldPosition(defaultFieldPosition)}</span>?
            </p>
            <button
              type="button"
              onClick={acceptDefaultFieldPosition}
              className="rounded-xl bg-sky-600 px-4 py-4 text-lg font-bold text-white active:bg-sky-700"
            >
              Yes, use this
            </button>
            <button
              type="button"
              onClick={() => openManualFieldPosition(defaultFieldPosition)}
              className="rounded-xl bg-slate-800 px-4 py-4 text-lg font-semibold text-slate-300 active:bg-slate-700"
            >
              No, set manually
            </button>
          </div>
        </Sheet>
      )}

      {sheet === "manageGame" && (
        <ManageGameSheet
          inProgress={!!inProgressGame}
          onClose={() => setSheet(null)}
          onNewGame={openGameSetup}
          onEndGame={openEndGameConfirm}
          onLogout={handleLogout}
        />
      )}

      {sheet === "gameSetup" && (
        <GameSetupSheet
          gameType={setupGameType}
          setGameType={setSetupGameType}
          opponent={setupOpponent}
          setOpponent={setSetupOpponent}
          homeAway={setupHomeAway}
          setHomeAway={setSetupHomeAway}
          receiving={setupReceiving}
          setReceiving={setSetupReceiving}
          onClose={() => setSheet(null)}
          onSubmit={submitGameSetup}
        />
      )}

      {sheet === "endGameConfirm" && (
        <EndGameConfirmSheet
          scoreUs={endGameScoreUs}
          setScoreUs={setEndGameScoreUs}
          scoreOpponent={endGameScoreOpponent}
          setScoreOpponent={setEndGameScoreOpponent}
          onClose={() => setSheet(null)}
          onConfirm={confirmEndGame}
        />
      )}

      {sheet === "result" && pendingResult === null && (
        <Sheet title="Result" onClose={() => setSheet(null)}>
          <div className="grid grid-cols-2 gap-3">
            {(["RUN", "PASS_COMPLETE", "SACK"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setPendingResult(t)}
                className="rounded-xl bg-slate-800 px-4 py-4 text-base font-semibold text-slate-100 active:bg-slate-700"
              >
                {RESULT_LABELS[t]}
              </button>
            ))}
            <button
              type="button"
              onClick={submitPassIncomplete}
              className="rounded-xl bg-slate-800 px-4 py-4 text-base font-semibold text-slate-100 active:bg-slate-700"
            >
              {RESULT_LABELS.PASS_INCOMPLETE}
            </button>
            <button
              type="button"
              onClick={() => setPendingResult("PENALTY")}
              className="rounded-xl bg-slate-800 px-4 py-4 text-base font-semibold text-slate-100 active:bg-slate-700"
            >
              {RESULT_LABELS.PENALTY}
            </button>
            <button
              type="button"
              onClick={() => setSheet("turnoverType")}
              className="rounded-xl bg-red-600 px-4 py-4 text-base font-semibold text-white active:bg-red-700"
            >
              {RESULT_LABELS.TURNOVER}
            </button>
            <button
              type="button"
              onClick={() => setSheet("score")}
              className="rounded-xl bg-emerald-600 px-4 py-4 text-base font-semibold text-white active:bg-emerald-700"
            >
              Score
            </button>
          </div>

          {/* Separated from the play-result grid above (own container,
              divider, distinct color) so it can't be mistaken for a play
              result — ending a quarter isn't a play. */}
          <div className="mt-4 border-t border-slate-800 pt-4">
            <button
              type="button"
              onClick={() => setPendingResult("END_QUARTER")}
              className="w-full rounded-xl border-2 border-amber-500 px-4 py-4 text-base font-bold text-amber-400 active:bg-amber-950/30"
            >
              End Quarter
            </button>
          </div>
        </Sheet>
      )}

      {sheet === "result" && pendingResult === "END_QUARTER" && (
        <EndQuarterSheet
          quarter={state.quarter}
          onClose={() => setPendingResult(null)}
          onConfirmAdvance={confirmEndQuarterAdvance}
          onConfirmHalftime={confirmHalftime}
          onStartOvertime={confirmStartOvertime}
          onContinueOvertime={confirmContinueOvertime}
          onEndGame={goToEndGameFromQuarter}
        />
      )}

      {sheet === "score" && (
        <Sheet title="Score" onClose={() => setSheet("result")}>
          <div className="grid grid-cols-3 gap-3">
            <button
              type="button"
              onClick={() => setSheet("scoreTdMethod")}
              className="rounded-xl bg-emerald-600 px-4 py-6 text-lg font-bold text-white active:bg-emerald-700"
            >
              TD
            </button>
            <button
              type="button"
              onClick={openScoreFg}
              className="rounded-xl bg-emerald-600 px-4 py-6 text-lg font-bold text-white active:bg-emerald-700"
            >
              FG
            </button>
            <button
              type="button"
              onClick={openScoreSafety}
              className="rounded-xl bg-emerald-600 px-4 py-6 text-lg font-bold text-white active:bg-emerald-700"
            >
              Safety
            </button>
          </div>
        </Sheet>
      )}

      {sheet === "scoreTdMethod" && (
        <Sheet title="TD — How?" onClose={() => setSheet("score")}>
          <div className="grid grid-cols-3 gap-3">
            <button
              type="button"
              onClick={() => submitScoreRunOrPass("RUN")}
              className="rounded-xl bg-emerald-600 px-4 py-6 text-lg font-bold text-white active:bg-emerald-700"
            >
              Run
            </button>
            <button
              type="button"
              onClick={() => submitScoreRunOrPass("PASS_COMPLETE")}
              className="rounded-xl bg-emerald-600 px-4 py-6 text-lg font-bold text-white active:bg-emerald-700"
            >
              Pass
            </button>
            <button
              type="button"
              onClick={openScoreTdKr}
              className="rounded-xl bg-emerald-600 px-4 py-6 text-lg font-bold text-white active:bg-emerald-700"
            >
              KR
            </button>
          </div>
        </Sheet>
      )}

      {sheet === "scoreTdKrTeam" && (
        <Sheet title="KR — Scoring Team?" onClose={() => setSheet("scoreTdMethod")}>
          <div className="flex flex-col gap-4">
            <ToggleRow
              label="Scoring Team"
              value={krTeam}
              disabled={false}
              onSelect={setKrTeam}
              options={[
                { value: "us", text: "Us", clean: true },
                { value: "opponent", text: "Opp", clean: true },
              ]}
            />
            <button
              type="button"
              onClick={submitScoreTdKr}
              className="rounded-xl bg-emerald-600 px-4 py-4 text-lg font-bold text-white active:bg-emerald-700"
            >
              Continue
            </button>
          </div>
        </Sheet>
      )}

      {sheet === "scoreTdDetails" && pendingTd && (
        <TdDetailsSheet
          method={pendingTd.method}
          time={tdTime}
          setTime={setTdTime}
          playerNumber={tdPlayerNumber}
          setPlayerNumber={setTdPlayerNumber}
          playerName={tdPlayerName}
          setPlayerName={setTdPlayerName}
          passerNumber={tdPasserNumber}
          setPasserNumber={setTdPasserNumber}
          passerName={tdPasserName}
          setPasserName={setTdPasserName}
          returnDistance={tdReturnDistance}
          setReturnDistance={setTdReturnDistance}
          onClose={submitTdDetails}
          onSubmit={submitTdDetails}
        />
      )}

      {sheet === "scoreTdConversion" && (
        <Sheet title="Conversion?" onClose={submitConversionNone}>
          <div className="flex flex-col gap-4">
            <button
              type="button"
              onClick={() => setSheet("scoreTdConversionPat")}
              className="rounded-xl bg-slate-800 px-4 py-4 text-lg font-bold text-slate-100 active:bg-slate-700"
            >
              PAT
            </button>
            <button
              type="button"
              onClick={() => setSheet("scoreTdConversionTwoPoint")}
              className="rounded-xl bg-slate-800 px-4 py-4 text-lg font-bold text-slate-100 active:bg-slate-700"
            >
              2-Point
            </button>
            <button
              type="button"
              onClick={submitConversionNone}
              className="rounded-xl bg-slate-800 px-4 py-4 text-lg font-semibold text-slate-300 active:bg-slate-700"
            >
              No Attempt
            </button>
          </div>
        </Sheet>
      )}

      {sheet === "scoreTdConversionPat" && (
        <Sheet title="PAT" onClose={() => setSheet("scoreTdConversion")}>
          <div className="flex flex-col gap-4">
            <NumberField label="Kicker # (optional)" value={conversionPlayerNumber} onChange={setConversionPlayerNumber} />
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                Kicker Name (optional)
              </span>
              <input
                type="text"
                value={conversionPlayerName}
                onChange={(e) => setConversionPlayerName(e.target.value)}
                className="rounded-xl bg-slate-800 px-4 py-3 text-lg font-bold text-slate-50"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => submitConversionPat("GOOD")}
                className="rounded-xl bg-emerald-600 px-4 py-4 text-lg font-bold text-white active:bg-emerald-700"
              >
                Good
              </button>
              <button
                type="button"
                onClick={() => submitConversionPat("NO_GOOD")}
                className="rounded-xl bg-red-600 px-4 py-4 text-lg font-bold text-white active:bg-red-700"
              >
                No Good
              </button>
            </div>
          </div>
        </Sheet>
      )}

      {sheet === "scoreTdConversionTwoPoint" && (
        <Sheet title="2-Point" onClose={() => setSheet("scoreTdConversion")}>
          <div className="flex flex-col gap-4">
            <ToggleRow
              label="Run or Pass"
              value={conversionMethod}
              disabled={false}
              onSelect={setConversionMethod}
              options={[
                { value: "RUN", text: "Run", clean: true },
                { value: "PASS", text: "Pass", clean: true },
              ]}
            />
            <NumberField label="Player # (optional)" value={conversionPlayerNumber} onChange={setConversionPlayerNumber} />
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                Player Name (optional)
              </span>
              <input
                type="text"
                value={conversionPlayerName}
                onChange={(e) => setConversionPlayerName(e.target.value)}
                className="rounded-xl bg-slate-800 px-4 py-3 text-lg font-bold text-slate-50"
              />
            </label>
            {conversionMethod === "PASS" && (
              <>
                <NumberField label="Passer # (optional)" value={conversionPasserNumber} onChange={setConversionPasserNumber} />
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                    Passer Name (optional)
                  </span>
                  <input
                    type="text"
                    value={conversionPasserName}
                    onChange={(e) => setConversionPasserName(e.target.value)}
                    className="rounded-xl bg-slate-800 px-4 py-3 text-lg font-bold text-slate-50"
                  />
                </label>
              </>
            )}
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => submitConversionTwoPoint("GOOD")}
                className="rounded-xl bg-emerald-600 px-4 py-4 text-lg font-bold text-white active:bg-emerald-700"
              >
                Good
              </button>
              <button
                type="button"
                onClick={() => submitConversionTwoPoint("NO_GOOD")}
                className="rounded-xl bg-red-600 px-4 py-4 text-lg font-bold text-white active:bg-red-700"
              >
                No Good
              </button>
            </div>
          </div>
        </Sheet>
      )}

      {sheet === "scoreFgResult" && (
        <Sheet title="Field Goal — Result?" onClose={() => setSheet("score")}>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => chooseFgResult("GOOD")}
              className="rounded-xl bg-emerald-600 px-4 py-6 text-lg font-bold text-white active:bg-emerald-700"
            >
              Good
            </button>
            <button
              type="button"
              onClick={() => chooseFgResult("NO_GOOD")}
              className="rounded-xl bg-red-600 px-4 py-6 text-lg font-bold text-white active:bg-red-700"
            >
              No Good
            </button>
          </div>
        </Sheet>
      )}

      {sheet === "scoreFgDetails" && (
        <Sheet title={`Field Goal — ${fgResult === "GOOD" ? "Good" : "No Good"}`} onClose={submitFgDetails}>
          <div className="flex flex-col gap-4">
            <NumberField label="Distance (yards)" value={fgDistance} onChange={setFgDistance} />
            <ClockField label="Time (optional)" digits={fgTime} onChange={setFgTime} />
            <NumberField label="Kicker # (optional)" value={fgKickerNumber} onChange={setFgKickerNumber} />
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                Kicker Name (optional)
              </span>
              <input
                type="text"
                value={fgKickerName}
                onChange={(e) => setFgKickerName(e.target.value)}
                className="rounded-xl bg-slate-800 px-4 py-3 text-lg font-bold text-slate-50"
              />
            </label>
            <button
              type="button"
              onClick={submitFgDetails}
              className="rounded-xl bg-indigo-600 px-4 py-4 text-lg font-bold text-white active:bg-indigo-700"
            >
              Log Field Goal
            </button>
          </div>
        </Sheet>
      )}

      {sheet === "scoreSafetyMethod" && (
        <Sheet title="Safety — How?" onClose={() => setSheet("score")}>
          <div className="grid grid-cols-3 gap-3">
            <button
              type="button"
              onClick={() => chooseSafetyMethod("RUN")}
              className="rounded-xl bg-emerald-600 px-4 py-6 text-lg font-bold text-white active:bg-emerald-700"
            >
              Run
            </button>
            <button
              type="button"
              onClick={() => chooseSafetyMethod("SACK")}
              className="rounded-xl bg-emerald-600 px-4 py-6 text-lg font-bold text-white active:bg-emerald-700"
            >
              Sack
            </button>
            <button
              type="button"
              onClick={() => chooseSafetyMethod("OTHER")}
              className="rounded-xl bg-emerald-600 px-4 py-6 text-lg font-bold text-white active:bg-emerald-700"
            >
              Other
            </button>
          </div>
        </Sheet>
      )}

      {sheet === "scoreSafetyDetails" && (
        <Sheet title="Safety Details" onClose={submitSafetyDetails}>
          <div className="flex flex-col gap-4">
            <ClockField label="Time (optional)" digits={safetyTime} onChange={setSafetyTime} />
            <NumberField label="Tackler # (optional)" value={safetyTacklerNumber} onChange={setSafetyTacklerNumber} />
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                Tackler Name (optional)
              </span>
              <input
                type="text"
                value={safetyTacklerName}
                onChange={(e) => setSafetyTacklerName(e.target.value)}
                className="rounded-xl bg-slate-800 px-4 py-3 text-lg font-bold text-slate-50"
              />
            </label>
            <button
              type="button"
              onClick={submitSafetyDetails}
              className="rounded-xl bg-indigo-600 px-4 py-4 text-lg font-bold text-white active:bg-indigo-700"
            >
              Continue
            </button>
          </div>
        </Sheet>
      )}

      {sheet === "turnoverType" && (
        <Sheet title="Turnover — Type?" onClose={() => setSheet("result")}>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={chooseTurnoverInt}
              className="rounded-xl bg-red-600 px-4 py-6 text-lg font-bold text-white active:bg-red-700"
            >
              INT
            </button>
            <button
              type="button"
              onClick={openTurnoverFumble}
              className="rounded-xl bg-red-600 px-4 py-6 text-lg font-bold text-white active:bg-red-700"
            >
              Fumble
            </button>
            <button
              type="button"
              onClick={submitTurnoverPuntOrOther}
              className="rounded-xl bg-slate-800 px-4 py-6 text-lg font-bold text-slate-100 active:bg-slate-700"
            >
              Punt
            </button>
            <button
              type="button"
              onClick={submitTurnoverPuntOrOther}
              className="rounded-xl bg-slate-800 px-4 py-6 text-lg font-bold text-slate-100 active:bg-slate-700"
            >
              Other
            </button>
          </div>
        </Sheet>
      )}

      {sheet === "turnoverFumblePlay" && (
        <Sheet title="Fumble — Offense's Play?" onClose={() => setSheet("turnoverType")}>
          <div className="flex flex-col gap-4">
            <ToggleRow
              label="Play Type"
              value={turnoverFumblePlayType}
              disabled={false}
              onSelect={setTurnoverFumblePlayType}
              options={[
                { value: "RUN", text: "Run", clean: true },
                { value: "PASS_COMPLETE", text: "Pass Complete", clean: true },
              ]}
            />
            <NumberField
              label="Yards gained before the fumble (optional)"
              value={turnoverFumbleYards}
              onChange={setTurnoverFumbleYards}
            />
            <button
              type="button"
              onClick={submitTurnoverFumble}
              className="rounded-xl bg-indigo-600 px-4 py-4 text-lg font-bold text-white active:bg-indigo-700"
            >
              Continue
            </button>
          </div>
        </Sheet>
      )}

      {sheet === "turnoverReturnedForTd" && (
        <Sheet title="Returned for a TD?" onClose={() => turnoverReturnedForTd(false)}>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => turnoverReturnedForTd(true)}
              className="rounded-xl bg-emerald-600 px-4 py-6 text-lg font-bold text-white active:bg-emerald-700"
            >
              Yes
            </button>
            <button
              type="button"
              onClick={() => turnoverReturnedForTd(false)}
              className="rounded-xl bg-slate-800 px-4 py-6 text-lg font-bold text-slate-100 active:bg-slate-700"
            >
              No
            </button>
          </div>
        </Sheet>
      )}

      {sheet === "result" &&
        (pendingResult === "RUN" || pendingResult === "PASS_COMPLETE" || pendingResult === "SACK") && (
        <Sheet title={`${RESULT_LABELS[pendingResult]} — Yardage`} onClose={() => setPendingResult(null)}>
          <div className="flex flex-col gap-4">
            {pendingResult === "SACK" ? (
              <p className="text-center text-sm font-semibold uppercase tracking-widest text-red-400">
                Loss
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setYardageSign(1)}
                  className={[
                    "rounded-xl px-4 py-4 text-lg font-bold",
                    yardageSign === 1 ? "bg-emerald-500 text-emerald-950" : "bg-slate-800 text-slate-300",
                  ].join(" ")}
                >
                  GAIN
                </button>
                <button
                  type="button"
                  onClick={() => setYardageSign(-1)}
                  className={[
                    "rounded-xl px-4 py-4 text-lg font-bold",
                    yardageSign === -1 ? "bg-red-500 text-red-950" : "bg-slate-800 text-slate-300",
                  ].join(" ")}
                >
                  LOSS
                </button>
              </div>
            )}
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={yardageMagnitude}
              onChange={(e) => setYardageMagnitude(e.target.value)}
              className="rounded-xl bg-slate-800 px-4 py-4 text-center text-2xl font-bold text-slate-50"
            />
            <button
              type="button"
              onClick={() => submitRunOrPass(pendingResult)}
              className="rounded-xl bg-indigo-600 px-4 py-4 text-lg font-bold text-white active:bg-indigo-700"
            >
              Log Play
            </button>
          </div>
        </Sheet>
      )}

      {sheet === "result" && pendingResult === "PENALTY" && (
        <Sheet title="Penalty — Resulting State" onClose={() => setPendingResult(null)}>
          <div className="flex flex-col gap-4">
            <NumberField label="Down (1-4)" value={penaltyDown} onChange={setPenaltyDown} />
            <NumberField label="Distance" value={penaltyDistance} onChange={setPenaltyDistance} />
            <NumberField label="Field Position (1-99)" value={penaltyFieldPosition} onChange={setPenaltyFieldPosition} />
            <button
              type="button"
              onClick={submitPenalty}
              className="rounded-xl bg-indigo-600 px-4 py-4 text-lg font-bold text-white active:bg-indigo-700"
            >
              Log Penalty
            </button>
          </div>
        </Sheet>
      )}

      {liveStatsOpen && (
        <LiveStatsOverlay
          stats={liveStats}
          loading={liveStatsLoading}
          onClose={() => setLiveStatsOpen(false)}
        />
      )}
    </main>
  );
}

function LiveStatsButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-full border border-slate-600 px-3 py-1 text-xs font-medium uppercase tracking-wide text-slate-300 active:bg-slate-800 disabled:opacity-40"
    >
      Live Stats
    </button>
  );
}

/**
 * On-demand mid-game stats snapshot — same Offense/Defense tables as the
 * Sideline EoG summary (via the shared StatBreakdown), just without a final
 * score section, since the game may still be in progress. A full-screen
 * overlay (not the bottom Sheet drawer other Booth actions use) since the
 * content can run longer than one screen and needs its own scroll; a single
 * Close button keeps it a quick look, not a mode the booth can get stuck in.
 */
function LiveStatsOverlay({
  stats,
  loading,
  onClose,
}: {
  stats: GameStats | null;
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-slate-950">
      <header className="flex flex-none items-center justify-between border-b border-slate-800 px-5 py-4">
        <h2 className="text-lg font-bold text-slate-50">Live Stats</h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-300 active:bg-slate-700"
        >
          Close
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-5">
        {loading ? (
          <p className="text-center text-sm text-slate-400">Loading…</p>
        ) : (
          <div className="flex flex-col items-center gap-6 pb-8">
            <StatBreakdown stats={stats} />
          </div>
        )}
      </div>
    </div>
  );
}

function ManageGameButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full border border-slate-600 px-3 py-1 text-xs font-medium uppercase tracking-wide text-slate-300 active:bg-slate-800"
    >
      Manage Game
    </button>
  );
}

function ManageGameSheet({
  inProgress,
  onClose,
  onNewGame,
  onEndGame,
  onLogout,
}: {
  inProgress: boolean;
  onClose: () => void;
  onNewGame: () => void;
  onEndGame: () => void;
  onLogout: () => void;
}) {
  return (
    <Sheet title="Manage Game" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <button
          type="button"
          disabled={inProgress}
          onClick={onNewGame}
          className="rounded-xl bg-sky-600 px-4 py-4 text-lg font-bold text-white active:bg-sky-700 disabled:opacity-40"
        >
          New Game
        </button>
        <button
          type="button"
          disabled={!inProgress}
          onClick={onEndGame}
          className="rounded-xl bg-red-600 px-4 py-4 text-lg font-bold text-white active:bg-red-700 disabled:opacity-40"
        >
          End Game
        </button>
        <button
          type="button"
          onClick={onLogout}
          className="mt-2 rounded-xl border border-slate-700 px-4 py-3 text-sm font-semibold text-slate-400 active:bg-slate-800"
        >
          Logout
        </button>
      </div>
    </Sheet>
  );
}

function GameSetupSheet({
  gameType,
  setGameType,
  opponent,
  setOpponent,
  homeAway,
  setHomeAway,
  receiving,
  setReceiving,
  onClose,
  onSubmit,
}: {
  gameType: GameType;
  setGameType: (v: GameType) => void;
  opponent: string;
  setOpponent: (v: string) => void;
  homeAway: "home" | "away";
  setHomeAway: (v: "home" | "away") => void;
  receiving: "us" | "opponent";
  setReceiving: (v: "us" | "opponent") => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const valid = opponent.trim().length > 0;
  return (
    <Sheet title="New Game" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <ToggleRow
          label="Game Type"
          value={gameType}
          disabled={false}
          onSelect={setGameType}
          options={[
            { value: "real", text: "Real Game", clean: true },
            { value: "practice", text: "Practice", clean: true },
          ]}
        />
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">
            Opponent
          </span>
          <input
            type="text"
            value={opponent}
            onChange={(e) => setOpponent(e.target.value)}
            placeholder="Opponent name"
            className="rounded-xl bg-slate-800 px-4 py-3 text-lg font-bold text-slate-50"
          />
        </label>
        <ToggleRow
          label="Home / Away"
          value={homeAway}
          disabled={false}
          onSelect={setHomeAway}
          options={[
            { value: "home", text: "Home", clean: true },
            { value: "away", text: "Away", clean: true },
          ]}
        />
        <ToggleRow
          label="Who receives the opening kickoff?"
          value={receiving}
          disabled={false}
          onSelect={setReceiving}
          options={[
            { value: "us", text: "Us", clean: true },
            { value: "opponent", text: "Opponent", clean: true },
          ]}
        />
        <button
          type="button"
          disabled={!valid}
          onClick={onSubmit}
          className="rounded-xl bg-sky-600 px-4 py-4 text-lg font-bold text-white active:bg-sky-700 disabled:opacity-50"
        >
          Start Game
        </button>
      </div>
    </Sheet>
  );
}

function EndGameConfirmSheet({
  scoreUs,
  setScoreUs,
  scoreOpponent,
  setScoreOpponent,
  onClose,
  onConfirm,
}: {
  scoreUs: string;
  setScoreUs: (v: string) => void;
  scoreOpponent: string;
  setScoreOpponent: (v: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const validScore = (v: string) => {
    const n = Number(v);
    return v.trim() !== "" && Number.isInteger(n) && n >= 0;
  };
  const valid = validScore(scoreUs) && validScore(scoreOpponent);
  return (
    <Sheet title="End Game" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-lg text-slate-200">
          End the current game? Play-logging will lock until a new game is started. This can&apos;t
          be undone from the app.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <NumberField label="Final Score — Us" value={scoreUs} onChange={setScoreUs} />
          <NumberField label="Final Score — Opponent" value={scoreOpponent} onChange={setScoreOpponent} />
        </div>
        <button
          type="button"
          disabled={!valid}
          onClick={onConfirm}
          className="rounded-xl bg-red-600 px-4 py-4 text-lg font-bold text-white active:bg-red-700 disabled:opacity-50"
        >
          End Game
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl bg-slate-800 px-4 py-4 text-lg font-semibold text-slate-300 active:bg-slate-700"
        >
          Cancel
        </button>
      </div>
    </Sheet>
  );
}

/**
 * Confirmation for the End Quarter action — content depends on which
 * quarter is ending (see plan section 3): Q1/Q3 just advance the tag, Q2 is
 * halftime (hands off to the caller's kickoff-screen flow), Q4/OT offer a
 * choice between ending the game and continuing play.
 */
function EndQuarterSheet({
  quarter,
  onClose,
  onConfirmAdvance,
  onConfirmHalftime,
  onStartOvertime,
  onContinueOvertime,
  onEndGame,
}: {
  quarter: Quarter;
  onClose: () => void;
  onConfirmAdvance: (next: Quarter) => void;
  onConfirmHalftime: () => void;
  onStartOvertime: () => void;
  onContinueOvertime: () => void;
  onEndGame: () => void;
}) {
  if (quarter === "Q1" || quarter === "Q3") {
    const next: Quarter = quarter === "Q1" ? "Q2" : "Q4";
    return (
      <Sheet title={`End ${quarter}?`} onClose={onClose}>
        <div className="flex flex-col gap-4">
          <p className="text-lg text-slate-200">
            Plays will now be tagged <span className="font-bold">{next}</span>.
          </p>
          <button
            type="button"
            onClick={() => onConfirmAdvance(next)}
            className="rounded-xl bg-amber-600 px-4 py-4 text-lg font-bold text-white active:bg-amber-700"
          >
            End {quarter}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-slate-800 px-4 py-4 text-lg font-semibold text-slate-300 active:bg-slate-700"
          >
            Cancel
          </button>
        </div>
      </Sheet>
    );
  }

  if (quarter === "Q2") {
    return (
      <Sheet title="End Q2 — Halftime?" onClose={onClose}>
        <div className="flex flex-col gap-4">
          <p className="text-lg text-slate-200">
            Plays will now be tagged <span className="font-bold">Q3</span>. You&apos;ll be taken
            to the second-half kickoff screen.
          </p>
          <button
            type="button"
            onClick={onConfirmHalftime}
            className="rounded-xl bg-amber-600 px-4 py-4 text-lg font-bold text-white active:bg-amber-700"
          >
            End Q2 — Halftime
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-slate-800 px-4 py-4 text-lg font-semibold text-slate-300 active:bg-slate-700"
          >
            Cancel
          </button>
        </div>
      </Sheet>
    );
  }

  // Q4 or OT — both end in a choice, never a bare quarter advance.
  const title = quarter === "Q4" ? "End Q4?" : "End Overtime?";
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-lg text-slate-200">Choose how to proceed.</p>
        <button
          type="button"
          onClick={onEndGame}
          className="rounded-xl bg-red-600 px-4 py-4 text-lg font-bold text-white active:bg-red-700"
        >
          End Game
        </button>
        <button
          type="button"
          onClick={quarter === "Q4" ? onStartOvertime : onContinueOvertime}
          className="rounded-xl bg-amber-600 px-4 py-4 text-lg font-bold text-white active:bg-amber-700"
        >
          {quarter === "Q4" ? "Start Overtime" : "Continue Overtime"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl bg-slate-800 px-4 py-4 text-lg font-semibold text-slate-300 active:bg-slate-700"
        >
          Cancel
        </button>
      </div>
    </Sheet>
  );
}

/**
 * TD details form — shared by every TD path (Run/Pass, KR, INT/FR
 * returns). Every field is optional; submitting with all of them blank
 * must work (section 4). Passer fields only show for a passing TD; return
 * distance only for a return (INT/FR/KR) — a Run/Pass TD's distance is
 * already known (the scoring play's own yardage), so it isn't re-asked
 * here.
 */
function TdDetailsSheet({
  method,
  time,
  setTime,
  playerNumber,
  setPlayerNumber,
  playerName,
  setPlayerName,
  passerNumber,
  setPasserNumber,
  passerName,
  setPasserName,
  returnDistance,
  setReturnDistance,
  onClose,
  onSubmit,
}: {
  method: ScoreMethod;
  time: string;
  setTime: (v: string) => void;
  playerNumber: string;
  setPlayerNumber: (v: string) => void;
  playerName: string;
  setPlayerName: (v: string) => void;
  passerNumber: string;
  setPasserNumber: (v: string) => void;
  passerName: string;
  setPasserName: (v: string) => void;
  returnDistance: string;
  setReturnDistance: (v: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const isReturn = method === "INT" || method === "FR" || method === "KR";
  const playerLabel = method === "PASS" ? "Receiver" : isReturn ? "Returner" : "Ball Carrier";
  return (
    <Sheet title="TD Details" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <ClockField label="Time (optional)" digits={time} onChange={setTime} />
        <NumberField label={`${playerLabel} # (optional)`} value={playerNumber} onChange={setPlayerNumber} />
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">
            {playerLabel} Name (optional)
          </span>
          <input
            type="text"
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
            className="rounded-xl bg-slate-800 px-4 py-3 text-lg font-bold text-slate-50"
          />
        </label>
        {method === "PASS" && (
          <>
            <NumberField label="Passer # (optional)" value={passerNumber} onChange={setPasserNumber} />
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                Passer Name (optional)
              </span>
              <input
                type="text"
                value={passerName}
                onChange={(e) => setPasserName(e.target.value)}
                className="rounded-xl bg-slate-800 px-4 py-3 text-lg font-bold text-slate-50"
              />
            </label>
          </>
        )}
        {isReturn && (
          <NumberField
            label="Return Distance (optional)"
            value={returnDistance}
            onChange={setReturnDistance}
          />
        )}
        <button
          type="button"
          onClick={onSubmit}
          className="rounded-xl bg-indigo-600 px-4 py-4 text-lg font-bold text-white active:bg-indigo-700"
        >
          Continue
        </button>
      </div>
    </Sheet>
  );
}

function PracticeBanner() {
  return (
    <div className="rounded-xl bg-indigo-600 px-4 py-2 text-center text-sm font-bold uppercase tracking-widest text-white">
      Practice Mode
    </div>
  );
}

function ModeToggle({
  mode,
  onChange,
  disabled,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
  disabled: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {(["OFFENSE", "DEFENSE"] as const).map((m) => (
        <button
          key={m}
          type="button"
          disabled={disabled}
          onClick={() => onChange(m)}
          className={[
            "rounded-2xl px-4 py-4 text-lg font-bold disabled:opacity-50",
            mode === m
              ? "bg-slate-100 text-slate-900"
              : "bg-slate-800 text-slate-400 active:bg-slate-700",
          ].join(" ")}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">{label}</span>
      <input
        type="number"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-xl bg-slate-800 px-4 py-3 text-xl font-bold text-slate-50"
      />
    </label>
  );
}

/**
 * Numeric-keypad time input that auto-formats as the operator types — "127"
 * displays as "1:27". `digits` is the raw typed string (parent-held state,
 * per this file's convention); the last 2 digits are always seconds.
 */
function ClockField({
  label,
  digits,
  onChange,
}: {
  label: string;
  digits: string;
  onChange: (digits: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">{label}</span>
      <input
        type="text"
        inputMode="numeric"
        value={digits === "" ? "" : formatClockDigits(digits)}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(-4))}
        placeholder="0:00"
        className="rounded-xl bg-slate-800 px-4 py-3 text-xl font-bold text-slate-50"
      />
    </label>
  );
}

function NewDriveSheet({
  fieldPosition,
  setFieldPosition,
  onClose,
  onSubmit,
}: {
  fieldPosition: string;
  setFieldPosition: (v: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const fp = Number(fieldPosition);
  const valid = Number.isInteger(fp) && fp >= 1 && fp <= 99;
  return (
    <Sheet title="New Drive — 1 & P" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <NumberField label="Field Position (1-99, yards to opp. goal)" value={fieldPosition} onChange={setFieldPosition} />
        {valid && <p className="text-sm text-slate-400">= {formatFieldPosition(fp)}</p>}
        <button
          type="button"
          disabled={!valid}
          onClick={onSubmit}
          className="rounded-xl bg-sky-600 px-4 py-4 text-lg font-bold text-white active:bg-sky-700 disabled:opacity-50"
        >
          Start Drive
        </button>
      </div>
    </Sheet>
  );
}

function StatusPill({ status }: { status: TapStatus }) {
  if (status === "idle") return null;
  const text = { sending: "Sending…", sent: "Sent ✓", error: "Failed — retry tap" }[status];
  const color =
    status === "error"
      ? "bg-red-950 text-red-300"
      : status === "sent"
        ? "bg-emerald-950 text-emerald-300"
        : "bg-slate-800 text-slate-300";
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${color}`}>{text}</span>
  );
}
