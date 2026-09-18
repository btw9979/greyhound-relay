"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  applyRunOrPassResult,
  attackingFieldPosition,
  endGame,
  formatDownDistance,
  formatFieldPosition,
  getCurrentGame,
  normalizePlayFromDb,
  startNewGame,
  DEFAULT_DISTANCE,
  DEFAULT_DOWN,
  DEFAULT_FLAT,
  DEFAULT_FORMATION,
  DEFAULT_HASH,
  DEFAULT_PERSONNEL,
  DEFAULT_SPLITS,
  DEFAULT_THREE_TECH,
} from "@/lib/plays";
import type {
  Down,
  Flat,
  Formation,
  Game,
  GameType,
  Hash,
  Mode,
  Personnel,
  Play,
  ResultType,
  ScorePlayType,
  Splits,
  ThreeTech,
} from "@/lib/plays";
import { SwitchRole } from "@/components/SwitchRole";
import { Sheet } from "@/components/Sheet";
import { ExceptionToggle } from "@/components/ExceptionToggle";

type TapStatus = "idle" | "sending" | "sent" | "error";

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
    | null
  >(null);
  const [newDriveField, setNewDriveField] = useState("");

  const [setupGameType, setSetupGameType] = useState<GameType>("real");
  const [setupOpponent, setSetupOpponent] = useState("");
  const [setupHomeAway, setSetupHomeAway] = useState<"home" | "away">("home");
  const [setupReceiving, setSetupReceiving] = useState<"us" | "opponent">("us");

  const [endGameScoreUs, setEndGameScoreUs] = useState("");
  const [endGameScoreOpponent, setEndGameScoreOpponent] = useState("");

  const [pendingResult, setPendingResult] = useState<ResultType | null>(null);
  const [yardageSign, setYardageSign] = useState<1 | -1>(1);
  const [yardageMagnitude, setYardageMagnitude] = useState("0");
  const [penaltyDown, setPenaltyDown] = useState(String(DEFAULT_DOWN));
  const [penaltyDistance, setPenaltyDistance] = useState("10");
  const [penaltyFieldPosition, setPenaltyFieldPosition] = useState("50");

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

  const insert = useCallback(
    async (
      next: GameState,
      result: { type: ResultType; yards: number | null; scorePlayType?: ScorePlayType } | null,
    ) => {
      if (!game || !userId) return false;
      setStatus("sending");
      const { error } = await supabase.from("plays").insert({
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
        result_type: result?.type ?? null,
        result_yards: result?.yards ?? null,
        score_play_type: result?.scorePlayType ?? null,
      });
      setStatus(error ? "error" : "sent");
      if (!error) {
        setTimeout(() => setStatus((s) => (s === "sent" ? "idle" : s)), 1500);
      }
      return !error;
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

  // The mode the about-to-start drive will use: a pending switch if one is
  // underway (toggle, Turnover/Score, or turnover on downs), otherwise the
  // current state's mode — or, before any drive has ever started,
  // whatever's selected on the bootstrap screen's mode toggle.
  const effectiveMode = state ? pendingDriveMode ?? state.mode : pendingMode;

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
    // No previous play to default from yet (very first drive of the game)
    // — go straight to manual entry.
    if (!state) {
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
    };
    const ok = await insert(next, null);
    if (ok) {
      setState(next);
      setSheet(null);
      resetDriveFlow();
    }
    return ok;
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

  async function submitResult(
    type: ResultType,
    yards: number | null,
    overrides?: Partial<GameState>,
    scorePlayType?: ScorePlayType,
  ): Promise<boolean> {
    if (!state) return false;
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
    const ok = await insert(next, { type, yards, scorePlayType });
    if (!ok) return false;
    setState(next);
    setSheet(null);
    setPendingResult(null);

    // Unlike the manual toggle, Turnover/Score unambiguously mean a mode
    // switch and a new drive — no confirmation prompt, straight to the
    // field-position step.
    if (type === "TURNOVER" || type === "SCORE") {
      triggerAutoNewDrive(next.mode, next.fieldPosition, type);
    }
    return true;
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

  function submitScore(scorePlayType: ScorePlayType) {
    if (!state) return;
    // A score is a real scrimmage play covering a real distance — from the
    // current spot to the goal line — not just a drive-ending event with
    // no yardage, unlike Turnover/Penalty. Computed the same way P & Goal
    // is: the current offense's attacking-frame distance to the goal.
    const yards = attackingFieldPosition(state.mode, state.fieldPosition);
    submitResult("SCORE", yards, undefined, scorePlayType);
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

  if (!state) {
    return (
      <main className="flex flex-1 flex-col gap-8 p-5">
        <header className="flex items-center justify-between">
          <h1 className="text-lg font-bold text-slate-50">Booth</h1>
          <div className="flex items-center gap-3">
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
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col gap-6 p-5">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-slate-50">Booth</h1>
        <div className="flex items-center gap-3">
          <StatusPill status={status} />
          <ManageGameButton onClick={() => setSheet("manageGame")} />
          <SwitchRole current="booth" />
        </div>
      </header>

      {game?.game_type === "practice" && <PracticeBanner />}

      {initError && (
        <p className="rounded-xl bg-red-950 px-4 py-3 text-sm text-red-300">{initError}</p>
      )}

      <div className="flex items-center justify-between rounded-xl bg-slate-900 px-4 py-3 text-sm text-slate-300">
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
              onClick={() => submitResult("TURNOVER", null)}
              className="rounded-xl bg-red-600 px-4 py-4 text-base font-semibold text-white active:bg-red-700"
            >
              {RESULT_LABELS.TURNOVER}
            </button>
            <button
              type="button"
              onClick={() => setPendingResult("SCORE")}
              className="rounded-xl bg-emerald-600 px-4 py-4 text-base font-semibold text-white active:bg-emerald-700"
            >
              {RESULT_LABELS.SCORE}
            </button>
          </div>
        </Sheet>
      )}

      {sheet === "result" && pendingResult === "SCORE" && (
        <Sheet title="TD — Run or Pass?" onClose={() => setPendingResult(null)}>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => submitScore("RUN")}
              className="rounded-xl bg-emerald-600 px-4 py-6 text-lg font-bold text-white active:bg-emerald-700"
            >
              Run
            </button>
            <button
              type="button"
              onClick={() => submitScore("PASS_COMPLETE")}
              className="rounded-xl bg-emerald-600 px-4 py-6 text-lg font-bold text-white active:bg-emerald-700"
            >
              Pass
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
    </main>
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
