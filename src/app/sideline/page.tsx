"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getCurrentGame, formatDownDistance, formatFieldPosition } from "@/lib/plays";
import type { Game, Play } from "@/lib/plays";
import { SwitchRole } from "@/components/SwitchRole";
import { useWakeLock } from "@/lib/useWakeLock";
import { useOrientationLock } from "@/lib/useOrientationLock";

const FLAT_LABELS = { SET: "SET", DEFENDER: "DEFENDER" } as const;
const FORMATION_LABELS = { OPEN: "OPEN", CLOSED: "CLOSED" } as const;
const SPLITS_LABELS = {
  NONE: "Correct",
  FLANKER_TIGHT: "Flanker tight",
  SLOT_TIGHT: "Slot tight",
  BOTH_TIGHT: "Both tight",
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
} as const;

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
      className={`flex h-[29dvh] flex-none flex-col items-center justify-center rounded-3xl px-4 py-6 text-center transition-colors ${box}`}
    >
      <span className="text-sm font-bold uppercase tracking-widest opacity-80">{label}</span>
      <span className="mt-1 flex items-center gap-2 text-4xl font-black leading-tight sm:text-5xl">
        <span aria-hidden="true">{icon}</span>
        {text}
      </span>
    </div>
  );
}

export default function SidelinePage() {
  useWakeLock();
  useOrientationLock();

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

  useEffect(() => {
    const tick = () => {
      setElapsed(displayLastUpdate === null ? null : Math.floor((Date.now() - displayLastUpdate) / 1000));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [displayLastUpdate]);

  const freshness = freshnessFor(elapsed);

  return (
    <main className="flex flex-1 flex-col gap-3 p-4">
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

      {!currentPlay && !initError && (
        <p className="flex flex-1 items-center justify-center text-center text-slate-400">
          Waiting for the booth to start the game…
        </p>
      )}

      {currentPlay && (
        <div className="flex flex-1 flex-col gap-3">
          <div className="grid min-h-[9dvh] flex-1 grid-cols-3 items-center gap-2 rounded-2xl bg-slate-900 px-3 py-3 text-center">
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

          <div className="flex flex-none flex-col gap-3">
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

            {currentPlay.mode === "OFFENSE" ? (
              <Tile
                label="Flat"
                text={FLAT_LABELS[currentPlay.flat ?? "SET"]}
                tone={currentPlay.flat === "DEFENDER" ? "alert" : "clean"}
              />
            ) : (
              <Tile
                label="Formation"
                text={FORMATION_LABELS[currentPlay.formation ?? "OPEN"]}
                tone={currentPlay.formation === "CLOSED" ? "alert" : "clean"}
              />
            )}
          </div>

          {currentPlay.mode === "OFFENSE" && (() => {
            const flagged = currentPlay.splits && currentPlay.splits !== "NONE";
            return (
              <div
                className={[
                  "flex min-h-[6dvh] flex-none flex-col items-center justify-center gap-0.5 rounded-2xl border-4 px-4 py-2 text-center transition-colors",
                  flagged
                    ? "border-black bg-amber-400 text-black"
                    : "border-black/15 bg-slate-900 text-slate-100",
                ].join(" ")}
              >
                <span className="text-[11px] font-bold uppercase tracking-widest opacity-80">
                  Splits
                </span>
                <span className="flex items-center gap-2 text-lg font-black sm:text-xl">
                  <span aria-hidden="true">{flagged ? "⚠" : "✓"}</span>
                  {SPLITS_LABELS[currentPlay.splits ?? "NONE"]}
                </span>
              </div>
            );
          })()}
        </div>
      )}

      <FreshnessBar freshness={freshness} elapsed={elapsed} connected={connected} />
    </main>
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
