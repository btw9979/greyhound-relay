import type { Score } from "@/lib/plays";

/**
 * Points a single score record is worth. A missed FG or a failed
 * conversion contributes 0 — the running score only moves on a made
 * kick/conversion, same as a real scoreboard.
 */
export function scorePoints(score: Score): number {
  if (score.score_type === "SAFETY") return 2;
  if (score.score_type === "FG") return score.fg_result === "GOOD" ? 3 : 0;
  // TD
  let points = 6;
  if (score.conversion_type === "PAT" && score.conversion_result === "GOOD") points += 1;
  else if (score.conversion_type === "TWO_POINT" && score.conversion_result === "GOOD") points += 2;
  return points;
}

export interface ScoringSummaryEntry {
  score: Score;
  usTotal: number;
  opponentTotal: number;
}

/**
 * Cumulative us/opponent totals after each score, in the order given
 * (chronological — see getGameScores). A missed FG contributes 0 points,
 * so its entry's totals are identical to the entry before it — that's
 * correct whether or not the caller ends up displaying that row (the read-
 * only scoring summary hides missed FGs; Edit Scoring shows them).
 */
export function runningScoreEntries(scores: Score[]): ScoringSummaryEntry[] {
  let usTotal = 0;
  let opponentTotal = 0;
  return scores.map((score) => {
    const points = scorePoints(score);
    if (score.scoring_team === "us") usTotal += points;
    else opponentTotal += points;
    return { score, usTotal, opponentTotal };
  });
}

/** "#12 Wagner" / "Wagner" / "#12" / "" depending on which of number/name are recorded. */
export function formatPlayerLabel(number: string | null, name: string | null): string {
  if (number && name) return `#${number} ${name}`;
  if (name) return name;
  if (number) return `#${number}`;
  return "";
}

function formatYardPhrase(distance: number | null, noun: string): string {
  return distance !== null ? `${distance} yd ${noun}` : noun;
}

const TD_NOUN: Record<NonNullable<Score["method"]>, string> = {
  RUN: "run",
  PASS: "pass",
  INT: "interception return",
  FR: "fumble return",
  KR: "kick return",
};

/** The conversion's parenthetical, e.g. "Smith kick" / "kick failed" — null when there's nothing to show. */
function describeConversion(score: Score): string | null {
  if (score.conversion_type === "PAT") {
    if (score.conversion_result === "GOOD") {
      const kicker = formatPlayerLabel(score.conversion_player_number, score.conversion_player_name);
      return kicker ? `${kicker} kick` : "kick";
    }
    if (score.conversion_result === "NO_GOOD") return "kick failed";
    return null;
  }
  if (score.conversion_type === "TWO_POINT") {
    const player = formatPlayerLabel(score.conversion_player_number, score.conversion_player_name);
    const passer = formatPlayerLabel(score.conversion_passer_number, score.conversion_passer_name);
    if (score.conversion_result === "GOOD") {
      if (score.conversion_method === "PASS") {
        const base = player ? `${player} pass` : "pass";
        return passer ? `${base} from ${passer}` : base;
      }
      return player ? `${player} run` : "run";
    }
    if (score.conversion_result === "NO_GOOD") {
      return score.conversion_method === "PASS" ? "pass failed" : "run failed";
    }
    return null;
  }
  return null; // NONE, or never recorded
}

/**
 * Standard box-score line for one score record, e.g.
 * "Wagner 22 yd pass from Jones (Smith kick)". Every detail is optional —
 * missing ones are omitted cleanly (no stray separators/parens), which is
 * what makes it obvious at a glance which scores still need details filled
 * in. A missed FG is labeled "— No Good" (only ever shown in Edit
 * Scoring — the read-only scoring summary excludes missed FGs entirely).
 */
export function describeScore(score: Score): string {
  const player = formatPlayerLabel(score.player_number, score.player_name);

  if (score.score_type === "FG") {
    const base = [player, formatYardPhrase(score.distance_yards, "field goal")]
      .filter(Boolean)
      .join(" ");
    return score.fg_result === "NO_GOOD" ? `${base} — No Good` : base;
  }

  if (score.score_type === "SAFETY") {
    return player ? `Safety (${player})` : "Safety";
  }

  // TD
  const passer = formatPlayerLabel(score.passer_number, score.passer_name);
  const noun = TD_NOUN[score.method ?? "RUN"];
  let base = [player, formatYardPhrase(score.distance_yards, noun)].filter(Boolean).join(" ");
  if (score.method === "PASS" && passer) base = `${base} from ${passer}`;
  const conversion = describeConversion(score);
  return conversion ? `${base} (${conversion})` : base;
}

/**
 * The summary's first line: quarter, time (if recorded), "Opp" if the
 * opponent scored, and the running score (us first) — e.g.
 * "Q4 2:14 · 28-6", "Q3 11:11 · Opp · 6-6", or "Q4 · 28-6" with no time.
 */
export function formatScoreLine1(entry: ScoringSummaryEntry): string {
  const { score, usTotal, opponentTotal } = entry;
  const parts = [score.quarter + (score.clock ? ` ${score.clock}` : "")];
  if (score.scoring_team === "opponent") parts.push("Opp");
  parts.push(`${usTotal}-${opponentTotal}`);
  return parts.join(" · ");
}
