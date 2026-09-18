"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  getCurrentGame,
  formatDownDistance,
  formatFieldPosition,
  computeGameStats,
  normalizePlayFromDb,
  updateFinalScore,
} from "@/lib/plays";
import type {
  Game,
  Play,
  GameStats,
  PlayLogRow,
  RushingStats,
  PassingStats,
  TotalStats,
} from "@/lib/plays";
import { SwitchRole } from "@/components/SwitchRole";
import { useWakeLock } from "@/lib/useWakeLock";
import { useOrientationLock } from "@/lib/useOrientationLock";

const FLAT_LABELS = { SET: "CLEAR", DEFENDER: "DEFENDER" } as const;
const FORMATION_LABELS = { OPEN: "OPEN", CLOSED: "CLOSED" } as const;
const SPLITS_LABELS = {
  NONE: "Correct",
  FLANKER_TIGHT: "Flanker tight",
  SLOT_TIGHT: "Slot tight",
  BOTH_TIGHT: "Both tight",
} as const;
const THREE_TECH_LABELS = {
  FIELD: "Field",
  BOUNDARY: "Boundary",
  HEADS_UP: "Heads-Up",
} as const;

type Freshness = "fresh" | "stale" | "dead" | "none";

function freshnessFor(seconds: number | null): Freshness {
  if (seconds === null) return "none";
  if (seconds < 60) return "fresh";
  if (seconds < 120) return "stale";
  return "dead";
}

const TILE_TONE = {
  // Color is never the only signal: each tone also gets its own border
  // weight and icon glyph, so state reads the same in direct sunlight or
  // for a colorblind viewer. Fills are pushed to near-maximum saturation
  // rather than Tailwind's softer mid-tones, with pure black/white text.
  clean: {
    icon: "✓",
    box: "border-4 border-black/15 bg-emerald-400 text-black",
  },
  alert: {
    icon: "⚠",
    box: "border-4 border-black bg-red-500 text-black",
  },
  urgent: {
    icon: "‼",
    box: "animate-pulse border-[6px] border-black bg-red-600 text-white",
  },
  // Purely informational, no good/bad state — 3-Tech and Flat read by text,
  // not color, so this never changes regardless of value.
  neutral: {
    icon: "•",
    box: "border-4 border-black/15 bg-slate-900 text-slate-100",
  },
  // Splits' own softer "notice" convention (amber, not red) — distinct from
  // Personnel's clean/alert/urgent severity ladder.
  correct: {
    icon: "✓",
    box: "border-4 border-black/15 bg-slate-900 text-slate-100",
  },
  flagged: {
    icon: "⚠",
    box: "border-4 border-black bg-amber-400 text-black",
  },
} as const;

// flex-[3] only matters in Defense mode's flex-column stack (2 large tiles);
// it's inert when a Tile is placed in Offense mode's 2x2 grid instead, where
// the grid's own equal 1fr tracks size the cell. min-h-0 overrides
// flexbox/grid's default auto min-size, which would otherwise refuse to let
// this shrink below its content and defeat the fit-one-screen guarantee.
//
// The value text is sized with a container query (container-type: size on
// this div, font-size in cqw on the value span) rather than a fixed size per
// call site: it scales to whatever box the tile actually ends up with — big
// on Defense's full-width tiles, smaller on Offense's four-way grid — so it
// always fills the available space instead of leaving fixed dead margin,
// and self-corrects if the tile count/arrangement changes again later.
function Tile({
  label,
  text,
  tone,
}: {
  label: string;
  text: string;
  tone: keyof typeof TILE_TONE;
}) {
  const { icon, box } = TILE_TONE[tone];
  return (
    <div
      className={`flex min-h-0 flex-[3] flex-col items-center justify-center rounded-3xl px-3 py-3 text-center transition-colors [container-type:size] ${box}`}
    >
      <span className="text-sm font-bold uppercase tracking-widest opacity-80">{label}</span>
      <span className="mt-1 flex items-center gap-2 text-[clamp(1.25rem,16cqw,3rem)] font-black leading-tight">
        <span aria-hidden="true">{icon}</span>
        {text}
      </span>
    </div>
  );
}

export default function SidelinePage() {
  useWakeLock();
  useOrientationLock();

  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [game, setGame] = useState<Game | null>(null);
  const [play, setPlay] = useState<Play | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  // Tracks the current game and follows along whenever the booth starts a
  // new one (real or practice) — no page reload needed.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const currentGame = await getCurrentGame(supabase);
        if (!cancelled) setGame(currentGame);
      } catch {
        if (!cancelled) setInitError("Couldn't reach the server. Check connection and reload.");
      }
    })();

    const channel = supabase
      .channel("games-latest")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "games" },
        (payload) => {
          setGame(payload.new as Game);
        },
      )
      .on(
        // Catches "End Game" (status -> complete) on the game already being
        // followed, so the end-of-game summary appears live.
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "games" },
        (payload) => {
          const updated = payload.new as Game;
          setGame((current) => (current && current.id === updated.id ? updated : current));
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  // Follows whichever game is current: loads its latest play and subscribes
  // to new ones. Play state isn't reset here on game change — see
  // `currentPlay` below, which derives "belongs to this game" from
  // play.game_id instead, so a switch to a new game never renders a flash
  // of the previous game's (already-stale) play as if it were current.
  useEffect(() => {
    if (!game) return;

    let cancelled = false;

    (async () => {
      const { data: latest } = await supabase
        .from("plays")
        .select("*")
        .eq("game_id", game.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!cancelled && latest) {
        setPlay(normalizePlayFromDb(latest as Play));
        setLastUpdate(Date.parse(latest.created_at));
      }
    })();

    const channel = supabase
      .channel(`plays-${game.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "plays", filter: `game_id=eq.${game.id}` },
        (payload) => {
          const row = normalizePlayFromDb(payload.new as Play);
          setPlay(row);
          setLastUpdate(Date.parse(row.created_at));
        },
      )
      .subscribe((status) => {
        if (!cancelled) setConnected(status === "SUBSCRIBED");
      });

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [supabase, game]);

  // Only trust play/lastUpdate once they actually belong to the current
  // game — see the comment on the effect above.
  const currentPlay = play && game && play.game_id === game.id ? play : null;
  const displayLastUpdate = currentPlay ? lastUpdate : null;

  // Fetched once a game is marked complete: the full play log, reduced to
  // Offense/Defense stat tables for the EoG summary.
  const [summary, setSummary] = useState<{ gameId: string; stats: GameStats } | null>(null);

  useEffect(() => {
    if (!game || game.status !== "complete") return;
    let cancelled = false;

    (async () => {
      // computeGameStats needs chronological order — 3rd Down Conversions
      // depends on play sequence, not just independent per-row totals.
      const { data } = await supabase
        .from("plays")
        .select("mode, down, result_type, result_yards, score_play_type")
        .eq("game_id", game.id)
        .order("created_at", { ascending: true });

      if (cancelled || !data) return;
      setSummary({
        gameId: game.id,
        stats: computeGameStats(data as PlayLogRow[]),
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [supabase, game]);

  const currentStats =
    game && game.status === "complete" && summary?.gameId === game.id ? summary.stats : null;

  async function handleSaveFinalScore(us: number, opponent: number) {
    if (!game) return;
    await updateFinalScore(supabase, game.id, { us, opponent });
    setGame({ ...game, final_score_us: us, final_score_opponent: opponent });
  }

  useEffect(() => {
    const tick = () => {
      setElapsed(displayLastUpdate === null ? null : Math.floor((Date.now() - displayLastUpdate) / 1000));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [displayLastUpdate]);

  const freshness = freshnessFor(elapsed);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  const gameOver = game?.status === "complete";

  return (
    <main
      className={
        gameOver
          ? "flex min-h-dvh flex-col gap-3 p-4"
          : "flex h-dvh flex-col gap-3 overflow-hidden p-4"
      }
    >
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-slate-50">Sideline</h1>
        <SwitchRole current="sideline" />
      </header>

      {game?.game_type === "practice" && (
        <div className="rounded-xl bg-indigo-600 px-4 py-2 text-center text-sm font-bold uppercase tracking-widest text-white">
          Practice Mode
        </div>
      )}

      {initError && (
        <p className="rounded-xl bg-red-950 px-4 py-3 text-sm text-red-300">{initError}</p>
      )}

      {gameOver && game && (
        <GameSummary
          game={game}
          stats={currentStats}
          onSaveFinalScore={handleSaveFinalScore}
          onLogout={handleLogout}
        />
      )}

      {!gameOver && !currentPlay && !initError && (
        <p className="flex flex-1 items-center justify-center text-center text-slate-400">
          Waiting for the booth to start the game…
        </p>
      )}

      {!gameOver && currentPlay && (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="grid min-h-[9dvh] flex-none grid-cols-3 items-center gap-2 rounded-2xl bg-slate-900 px-3 py-3 text-center">
            <div className="flex flex-col">
              <span className="text-[11px] font-bold uppercase tracking-widest text-slate-300">
                Drive
              </span>
              <span className="text-2xl font-black text-slate-50 sm:text-3xl">{currentPlay.drive_number}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[11px] font-bold uppercase tracking-widest text-slate-300">
                Down &amp; Dist
              </span>
              <span className="text-2xl font-black text-slate-50 sm:text-3xl">
                {formatDownDistance(currentPlay.mode, currentPlay.down, currentPlay.distance, currentPlay.field_position)}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-[11px] font-bold uppercase tracking-widest text-slate-300">
                Ball On
              </span>
              <span className="text-2xl font-black text-slate-50 sm:text-3xl">
                {formatFieldPosition(currentPlay.field_position)}
              </span>
            </div>
          </div>

          {/* Fills whatever vertical space remains after the top bar and
              freshness bar. Offense: all four fields are equal-priority
              informational reads, laid out as a 2x2 grid (3-Tech/Flat on
              top, Personnel/Splits below) — grid-rows-2's minmax(0,1fr)
              tracks are the grid equivalent of min-h-0, letting rows shrink
              to fit rather than overflow. Defense is unchanged: Personnel/
              Formation stay in the original two-large-tile flex stack. */}
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            {currentPlay.mode === "OFFENSE" ? (
              <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-3">
                <Tile
                  label="3-Tech"
                  text={THREE_TECH_LABELS[currentPlay.three_tech ?? "FIELD"]}
                  tone="neutral"
                />
                <Tile
                  label="Flat"
                  text={FLAT_LABELS[currentPlay.flat ?? "SET"]}
                  tone="neutral"
                />
                <Tile
                  label="Personnel"
                  text={
                    currentPlay.personnel === "CLEAN"
                      ? "11 ON FIELD"
                      : currentPlay.personnel === "SHORT"
                        ? "SHORT"
                        : "OVER"
                  }
                  tone={currentPlay.personnel === "CLEAN" ? "clean" : currentPlay.personnel === "SHORT" ? "alert" : "urgent"}
                />
                <Tile
                  label="Splits"
                  text={SPLITS_LABELS[currentPlay.splits ?? "NONE"]}
                  tone={currentPlay.splits && currentPlay.splits !== "NONE" ? "flagged" : "correct"}
                />
              </div>
            ) : (
              <>
                <Tile
                  label="Personnel"
                  text={
                    currentPlay.personnel === "CLEAN"
                      ? "11 ON FIELD"
                      : currentPlay.personnel === "SHORT"
                        ? "SHORT"
                        : "OVER"
                  }
                  tone={currentPlay.personnel === "CLEAN" ? "clean" : currentPlay.personnel === "SHORT" ? "alert" : "urgent"}
                />
                <Tile
                  label="Formation"
                  text={FORMATION_LABELS[currentPlay.formation ?? "OPEN"]}
                  tone={currentPlay.formation === "CLOSED" ? "alert" : "clean"}
                />
              </>
            )}
          </div>
        </div>
      )}

      {!gameOver && (
        <FreshnessBar freshness={freshness} elapsed={elapsed} connected={connected} />
      )}
    </main>
  );
}

// Reviewed by the coaching staff during a post-game huddle — a minute to
// scan, not a glance-read. Unlike the live Sideline tiles, this is a
// standard scrollable page: no compression, no glance-legibility
// constraints, and no color-coding of stat VALUES (that's the coach's call
// to make, not the app's). Color only marks which tile is which.
function GameSummary({
  game,
  stats,
  onSaveFinalScore,
  onLogout,
}: {
  game: Game;
  stats: GameStats | null;
  onSaveFinalScore: (us: number, opponent: number) => Promise<void>;
  onLogout: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center gap-6 pb-8 text-center">
      <FinalScoreCard
        scoreUs={game.final_score_us}
        scoreOpponent={game.final_score_opponent}
        opponent={game.opponent}
        onSave={onSaveFinalScore}
      />

      <StatTile title="Offense" accent="offense">
        <MiniTable heading="Rushing" rows={offenseRushingRows(stats?.offense.rushing)} />
        <MiniTable heading="Passing" rows={offensePassingRows(stats?.offense.passing)} />
        <MiniTable heading="Total" rows={offenseTotalRows(stats?.offense.total)} emphasizeLast />
      </StatTile>

      <StatTile title="Defense" accent="defense">
        <MiniTable heading="Rushing" rows={defenseRushingRows(stats?.defense.rushing)} />
        <MiniTable heading="Passing" rows={defensePassingRows(stats?.defense.passing)} />
        <MiniTable heading="Total" rows={defenseTotalRows(stats?.defense.total)} emphasizeLast />
      </StatTile>

      <button
        type="button"
        onClick={onLogout}
        className="mt-2 rounded-xl border border-slate-600 px-6 py-3 text-sm font-semibold uppercase tracking-wide text-slate-300 active:bg-slate-800"
      >
        Log Out
      </button>
    </div>
  );
}

function FinalScoreCard({
  scoreUs,
  scoreOpponent,
  opponent,
  onSave,
}: {
  scoreUs: number | null;
  scoreOpponent: number | null;
  opponent: string | null;
  onSave: (us: number, opponent: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [us, setUs] = useState("");
  const [opp, setOpp] = useState("");
  const [saving, setSaving] = useState(false);

  function startEdit() {
    setUs(scoreUs === null ? "" : String(scoreUs));
    setOpp(scoreOpponent === null ? "" : String(scoreOpponent));
    setEditing(true);
  }

  async function save() {
    const usN = Number(us);
    const oppN = Number(opp);
    if (!Number.isInteger(usN) || usN < 0 || !Number.isInteger(oppN) || oppN < 0) return;
    setSaving(true);
    try {
      await onSave(usN, oppN);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    const valid = (v: string) => {
      const n = Number(v);
      return v.trim() !== "" && Number.isInteger(n) && n >= 0;
    };
    const canSave = valid(us) && valid(opp);
    return (
      <div className="flex w-full max-w-xs flex-col items-center gap-3 rounded-2xl border-4 border-black bg-slate-900 px-6 py-5">
        <span className="text-sm font-bold uppercase tracking-widest text-slate-400">
          Final Score
        </span>
        <div className="flex items-center gap-3">
          <input
            type="number"
            inputMode="numeric"
            value={us}
            onChange={(e) => setUs(e.target.value)}
            className="w-20 rounded-xl bg-slate-800 px-3 py-2 text-center text-3xl font-black text-slate-50"
            aria-label="Our final score"
          />
          <span className="text-2xl font-black text-slate-600">–</span>
          <input
            type="number"
            inputMode="numeric"
            value={opp}
            onChange={(e) => setOpp(e.target.value)}
            className="w-20 rounded-xl bg-slate-800 px-3 py-2 text-center text-3xl font-black text-slate-50"
            aria-label="Opponent final score"
          />
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            disabled={!canSave || saving}
            onClick={save}
            className="rounded-xl bg-sky-600 px-5 py-2 text-sm font-bold text-white active:bg-sky-700 disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="rounded-xl bg-slate-800 px-5 py-2 text-sm font-semibold text-slate-300 active:bg-slate-700"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={startEdit}
      className="flex w-full max-w-xs flex-col items-center gap-1 rounded-2xl border-4 border-black bg-slate-900 px-8 py-5 active:bg-slate-800"
    >
      <span className="text-sm font-bold uppercase tracking-widest text-slate-400">
        Final{opponent ? ` vs ${opponent}` : ""}
      </span>
      <span className="text-5xl font-black text-slate-50">
        {scoreUs ?? "—"}
        <span className="mx-3 text-slate-600">–</span>
        {scoreOpponent ?? "—"}
      </span>
      <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">
        Tap to edit
      </span>
    </button>
  );
}

const STAT_TILE_ACCENT = {
  offense: {
    border: "border-sky-700",
    bg: "bg-sky-950/40",
    heading: "text-sky-300",
  },
  // Deliberately not the emerald used for "clean"/positive state on the
  // live Sideline view — this is a structural cue, not a value judgment,
  // so it needs its own color. Red is off the table entirely: it already
  // means "urgent" everywhere else in the app.
  defense: {
    border: "border-teal-700",
    bg: "bg-teal-950/40",
    heading: "text-teal-300",
  },
} as const;

function StatTile({
  title,
  accent,
  children,
}: {
  title: string;
  accent: keyof typeof STAT_TILE_ACCENT;
  children: React.ReactNode;
}) {
  const { border, bg, heading } = STAT_TILE_ACCENT[accent];
  return (
    <div className={`w-full max-w-md rounded-2xl border-2 ${border} ${bg} p-5 text-left`}>
      <h2 className={`mb-3 text-center text-sm font-bold uppercase tracking-widest ${heading}`}>
        {title}
      </h2>
      <div className="flex flex-col gap-4">{children}</div>
    </div>
  );
}

function fmtInt(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : String(v);
}

function fmtRate(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : v.toFixed(1);
}

function fmtFraction(made: number | undefined, of: number | undefined): string {
  return made === undefined || of === undefined ? "—/—" : `${made}/${of}`;
}

type StatRow = readonly [label: string, value: string];

function offenseRushingRows(r: RushingStats | undefined): StatRow[] {
  return [
    ["Rushing Attempts", fmtInt(r?.attempts)],
    ["Rush", fmtInt(r?.yards)],
    ["Yards Per Carry", fmtRate(r?.yardsPerCarry)],
    ["Rushing TDs", fmtInt(r?.touchdowns)],
  ];
}

function offensePassingRows(p: PassingStats | undefined): StatRow[] {
  return [
    ["Pass", fmtInt(p?.yards)],
    ["Completions", fmtFraction(p?.completions, p?.attempts)],
    ["Yards Per Completion", fmtRate(p?.yardsPerCompletion)],
    ["Yards Per Attempt", fmtRate(p?.yardsPerAttempt)],
    ["Sacks", fmtInt(p?.sackCount)],
    ["Sack Yards", fmtInt(p?.sackYards)],
    ["Passing TDs", fmtInt(p?.touchdowns)],
  ];
}

function offenseTotalRows(t: TotalStats | undefined): StatRow[] {
  return [
    ["Total Offensive Plays", fmtInt(t?.plays)],
    ["First Downs", fmtInt(t?.firstDowns)],
    ["3rd Down Conversions", fmtFraction(t?.thirdDownConversions, t?.thirdDownAttempts)],
    ["Total Offense", fmtInt(t?.yards)],
  ];
}

function defenseRushingRows(r: RushingStats | undefined): StatRow[] {
  return [
    ["Rushing Attempts Allowed", fmtInt(r?.attempts)],
    ["Rush Allowed", fmtInt(r?.yards)],
    ["Yards Per Carry Allowed", fmtRate(r?.yardsPerCarry)],
    ["Rushing TDs Allowed", fmtInt(r?.touchdowns)],
  ];
}

function defensePassingRows(p: PassingStats | undefined): StatRow[] {
  return [
    ["Pass Allowed", fmtInt(p?.yards)],
    ["Completions Allowed", fmtFraction(p?.completions, p?.attempts)],
    ["Yards Per Completion Allowed", fmtRate(p?.yardsPerCompletion)],
    ["Yards Per Attempt Allowed", fmtRate(p?.yardsPerAttempt)],
    ["Sacks", fmtInt(p?.sackCount)],
    ["Sack Yards", fmtInt(p?.sackYards)],
    ["Passing TDs Allowed", fmtInt(p?.touchdowns)],
  ];
}

function defenseTotalRows(t: TotalStats | undefined): StatRow[] {
  return [
    ["Total Defensive Plays", fmtInt(t?.plays)],
    ["First Downs Allowed", fmtInt(t?.firstDowns)],
    ["3rd Down Conversions Allowed", fmtFraction(t?.thirdDownConversions, t?.thirdDownAttempts)],
    ["Total Defense", fmtInt(t?.yards)],
  ];
}

/** One of the three stacked tables (Rushing/Passing/Total) inside a StatTile. */
function MiniTable({
  heading,
  rows,
  emphasizeLast = false,
}: {
  heading: string;
  rows: StatRow[];
  emphasizeLast?: boolean;
}) {
  return (
    <div>
      <h3 className="mb-1.5 text-xs font-bold uppercase tracking-widest text-slate-400">{heading}</h3>
      <table className="w-full text-sm">
        <tbody className="divide-y divide-slate-800">
          {rows.map(([label, value], i) => {
            const last = emphasizeLast && i === rows.length - 1;
            return (
              <tr key={label} className={last ? "border-t-2 border-slate-700" : undefined}>
                <td className={last ? "pt-2.5 font-bold text-slate-100" : "py-1.5 text-slate-300"}>
                  {label}
                </td>
                <td
                  className={
                    last
                      ? "pt-2.5 text-right text-lg font-black text-slate-50"
                      : "py-1.5 text-right font-bold text-slate-50"
                  }
                >
                  {value}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FreshnessBar({
  freshness,
  elapsed,
  connected,
}: {
  freshness: Freshness;
  elapsed: number | null;
  connected: boolean;
}) {
  if (freshness === "none") {
    return (
      <p className="text-center text-xs text-slate-500">
        {connected ? "Connected — waiting for a read" : "Connecting…"}
      </p>
    );
  }

  if (freshness === "dead") {
    return (
      <div className="flex animate-pulse items-center justify-center gap-2 rounded-2xl border-4 border-white bg-red-600 px-4 py-4 text-center text-lg font-black text-white">
        <span aria-hidden="true">⛔</span> NO UPDATE — COMMS DOWN
      </div>
    );
  }

  if (freshness === "stale") {
    return (
      <div className="flex items-center justify-center gap-2 rounded-2xl border-4 border-black bg-amber-400 px-4 py-3 text-center text-base font-black text-black">
        <span aria-hidden="true">⚠</span> Check booth
      </div>
    );
  }

  return <p className="text-center text-sm font-semibold text-slate-300">updated {elapsed}s ago</p>;
}
