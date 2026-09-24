import type { Score } from "@/lib/plays";
import { describeScore, formatScoreLine1, runningScoreEntries } from "@/lib/scoring";

/**
 * Read-only scoring summary — shared by the Booth's Live Stats and the
 * Sideline EoG summary, same approach as StatBreakdown for the stat
 * tables. Lists scores in logged order, each as two lines (quarter/time/
 * running score, then a standard box-score description). A missed FG
 * isn't a score, so it's excluded here — see Edit Scoring for the list
 * that includes it.
 */
export function ScoringSummary({ scores }: { scores: Score[] }) {
  const entries = runningScoreEntries(scores).filter(
    ({ score }) => !(score.score_type === "FG" && score.fg_result === "NO_GOOD"),
  );

  if (entries.length === 0) {
    return (
      <div className="w-full max-w-md text-center text-sm text-slate-500">
        No scores logged yet.
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-md flex-col gap-3 text-left">
      <h2 className="text-center text-sm font-bold uppercase tracking-widest text-slate-400">
        Scoring Summary
      </h2>
      <ul className="flex flex-col gap-3">
        {entries.map(({ score, ...entry }) => (
          <li key={score.id} className="rounded-xl bg-slate-900 px-4 py-3">
            <p className="text-xs font-bold uppercase tracking-widest text-slate-400">
              {formatScoreLine1({ score, ...entry })}
            </p>
            <p className="text-sm font-semibold text-slate-100">{describeScore(score)}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
