"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { getCurrentGame, formatDownDistance, formatFieldPosition } from "@/lib/plays";
import type { Game, Play } from "@/lib/plays";
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
        setPlay(latest as Play);
        setLastUpdate(Date.parse(latest.created_at));
      }
    })();

    const channel = supabase
      .channel(`plays-${game.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "plays", filter: `game_id=eq.${game.id}` },
        (payload) => {
          const row = payload.new as Play;
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

  // Fetched once a game is marked complete: total scrimmage-play yardage
  // by mode. result_yards is null for Penalty/Turnover/Score rows already
  // (never populated for those results), so a plain sum naturally excludes
  // them without extra filtering. Sack yards are also summed separately
  // (filtered to result_type = 'SACK') without changing the combined
  // totals above — a sack's result_yards still counts toward them exactly
  // as it always has.
  const [summary, setSummary] = useState<{
    gameId: string;
    offenseYards: number;
    defenseYards: number;
    sackYardsLost: number;
    sackYardsGained: number;
  } | null>(null);

  useEffect(() => {
    if (!game || game.status !== "complete") return;
    let cancelled = false;

    (async () => {
      const { data } = await supabase
        .from("plays")
        .select("mode, result_type, result_yards")
        .eq("game_id", game.id);

      if (cancelled || !data) return;
      let offenseYards = 0;
      let defenseYards = 0;
      let sackYardsLost = 0;
      let sackYardsGained = 0;
      for (const row of data as {
        mode: "OFFENSE" | "DEFENSE";
        result_type: string | null;
        result_yards: number | null;
      }[]) {
        if (row.result_yards === null) continue;
        if (row.mode === "OFFENSE") offenseYards += row.result_yards;
        else defenseYards += row.result_yards;

        if (row.result_type !== "SACK") continue;
        if (row.mode === "OFFENSE") sackYardsLost += row.result_yards;
        else sackYardsGained += row.result_yards;
      }
      setSummary({ gameId: game.id, offenseYards, defenseYards, sackYardsLost, sackYardsGained });
    })();

    return () => {
      cancelled = true;
    };
  }, [supabase, game]);

  const currentSummary =
    game && game.status === "complete" && summary?.gameId === game.id ? summary : null;

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

  return (
    <main className="flex h-dvh flex-col gap-3 overflow-hidden p-4">
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

      {game?.status === "complete" && (
        <GameSummary
          offenseYards={currentSummary?.offenseYards ?? null}
          defenseYards={currentSummary?.defenseYards ?? null}
          sackYardsLost={currentSummary?.sackYardsLost ?? null}
          sackYardsGained={currentSummary?.sackYardsGained ?? null}
          onLogout={handleLogout}
        />
      )}

      {game?.status !== "complete" && !currentPlay && !initError && (
        <p className="flex flex-1 items-center justify-center text-center text-slate-400">
          Waiting for the booth to start the game…
        </p>
      )}

      {game?.status !== "complete" && currentPlay && (
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

      {game?.status !== "complete" && (
        <FreshnessBar freshness={freshness} elapsed={elapsed} connected={connected} />
      )}
    </main>
  );
}

function GameSummary({
  offenseYards,
  defenseYards,
  sackYardsLost,
  sackYardsGained,
  onLogout,
}: {
  offenseYards: number | null;
  defenseYards: number | null;
  sackYardsLost: number | null;
  sackYardsGained: number | null;
  onLogout: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
      <div className="flex flex-col items-center gap-1 rounded-2xl border-4 border-black bg-slate-900 px-8 py-5">
        <span className="text-3xl font-black uppercase tracking-widest text-slate-50">Final</span>
        <span className="text-sm font-bold uppercase tracking-widest text-slate-400">Game Ended</span>
      </div>
      <div className="grid w-full grid-cols-2 gap-4">
        <div className="flex flex-col items-center gap-1 rounded-2xl border-4 border-black/15 bg-emerald-400 px-4 py-6 text-black">
          <span className="text-sm font-bold uppercase tracking-widest opacity-80">
            Offense Yards
          </span>
          <span className="text-4xl font-black">{offenseYards ?? "—"}</span>
        </div>
        <div className="flex flex-col items-center gap-1 rounded-2xl border-4 border-black/15 bg-slate-800 px-4 py-6 text-slate-100">
          <span className="text-sm font-bold uppercase tracking-widest opacity-80">
            Yards Allowed
          </span>
          <span className="text-4xl font-black">{defenseYards ?? "—"}</span>
        </div>
      </div>
      <div className="grid w-full grid-cols-2 gap-4">
        <div className="flex flex-col items-center gap-1 rounded-2xl border-4 border-black/15 bg-emerald-400 px-4 py-6 text-black">
          <span className="text-sm font-bold uppercase tracking-widest opacity-80">
            Sack Yards Lost
          </span>
          <span className="text-4xl font-black">{sackYardsLost ?? "—"}</span>
        </div>
        <div className="flex flex-col items-center gap-1 rounded-2xl border-4 border-black/15 bg-slate-800 px-4 py-6 text-slate-100">
          <span className="text-sm font-bold uppercase tracking-widest opacity-80">
            Sack Yards Gained
          </span>
          <span className="text-4xl font-black">{sackYardsGained ?? "—"}</span>
        </div>
      </div>

      <button
        type="button"
        onClick={onLogout}
        className="mt-6 rounded-xl border border-slate-600 px-6 py-3 text-sm font-semibold uppercase tracking-wide text-slate-300 active:bg-slate-800"
      >
        Log Out
      </button>
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
