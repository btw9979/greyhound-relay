import type { GameStats, PassingStats, RushingStats, TotalStats } from "@/lib/plays";

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
    ["Total Rushing Yds", fmtInt(r?.yards)],
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
    ["Rushing Yds Allowed", fmtInt(r?.yards)],
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

/**
 * Offense/Defense stat tiles (Rushing/Passing/Total tables each) built from
 * `computeGameStats`. Shared by the Sideline EoG summary (post "End Game")
 * and the Booth's on-demand Live Stats view (mid-game) — same computation,
 * same rendering, just invoked at different trigger points. Deliberately
 * excludes any final-score display; that's specific to the true EoG summary.
 */
export function StatBreakdown({ stats }: { stats: GameStats | null }) {
  return (
    <>
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
    </>
  );
}
