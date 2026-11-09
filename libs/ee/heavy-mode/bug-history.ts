/**
 * Enterprise Code — see `license_ee.md`. Experiment (exp/finder-gap-tools):
 * a heavy pass that gets the repository's past bugs — Kody's bug, security and
 * performance suggestions that were implemented — and looks in this diff for
 * the same bugs again. The past bugs closest to the diff are picked by BM25
 * over their text, at most PAST_BUGS_MAX; the 2026-11-09 offline analysis
 * found picking by recency reaches almost none of the repeats.
 */
import type { HeavyLens } from './heavy-lenses';

export const PAST_BUGS_MAX = 25;

export interface PastBug {
    file: string;
    label: string;
    /** Kody's one-sentence summary of the suggestion. */
    summary: string;
    /** The suggestion's full text. */
    content: string;
    /** The code the suggestion pointed at. */
    existingCode?: string;
    createdAt: string;
}

export type PastBugFormat = 'full' | 'summary';

/** Where the past bugs come from. The experiment injects them (evals swap
 *  this export); a production source would read the repository's implemented
 *  suggestions created before the review. */
export function pastBugsFor(_input: { usageRunName?: string }): PastBug[] {
    return [];
}

const STOP = new Set(
    'the a an of to in and or is are be for on with that this it as by at from not no so when which can its into only than then their does do'.split(' '),
);

function tokens(text: string): string[] {
    return (text.toLowerCase().match(/[a-z][a-z0-9_]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w));
}

/** The past bugs closest to the diff text (BM25), most similar first; ties
 *  go to the most recent. */
export function selectPastBugs(pool: PastBug[], diffText: string, max = PAST_BUGS_MAX): PastBug[] {
    if (!pool.length) return [];
    const docs = pool.map((b) => tokens(`${b.summary} ${b.content}`));
    const df = new Map<string, number>();
    for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
    const n = docs.length;
    const avg = docs.reduce((s, d) => s + d.length, 0) / n || 1;
    const query = new Map<string, number>();
    for (const w of tokens(diffText)) query.set(w, (query.get(w) ?? 0) + 1);
    const scored = docs.map((d, i) => {
        const tf = new Map<string, number>();
        for (const w of d) tf.set(w, (tf.get(w) ?? 0) + 1);
        let score = 0;
        for (const [w, qn] of query) {
            const f = tf.get(w);
            if (!f) continue;
            const idf = Math.log(1 + (n - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
            score += ((idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * d.length) / avg))) * Math.min(qn, 3);
        }
        return { i, score };
    });
    return scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score || pool[b.i].createdAt.localeCompare(pool[a.i].createdAt))
        .slice(0, max)
        .map((s) => pool[s.i]);
}

export function formatPastBugs(bugs: PastBug[], format: PastBugFormat): string {
    return bugs
        .map((b, k) => {
            const head = `[${k + 1}] ${b.label} in ${b.file} (${b.createdAt.slice(0, 10)})`;
            const text = format === 'full' ? b.content.trim() : b.summary.trim();
            const code = b.existingCode?.trim() ? `\n    Code it pointed at:\n${b.existingCode.trim().split('\n').slice(0, 15).map((l) => `      ${l}`).join('\n')}` : '';
            return `${head}\n    ${text.replace(/\n+/g, '\n    ')}${code}`;
        })
        .join('\n\n');
}

const METHOD = `- A bug this repository already had, coming back. Below are bugs Kody reported in earlier reviews of this repository and that the team fixed. METHOD:
  1. For each past bug, state its mechanism in one line: what was missing or wrong (a guard, a timeout, a tenant check, an ownership check on a write, an error swallowed into an empty result, a limit applied too late, a case-sensitive comparison, an unbounded query...).
  2. Look in the code this PR adds or changes for the same mechanism, in any file. It does not have to be the same file or the same function: the same mistake made again elsewhere counts.
  3. Read the surrounding code with the tools before deciding: the guard may exist in a caller, or the case may be impossible.
  Report the changed line that repeats the mistake, and say which past bug it repeats. Do not report a past bug itself, only its repetition in this diff.`;

export function bugHistoryLens(bugs: PastBug[], format: PastBugFormat): HeavyLens {
    return {
        id: format === 'full' ? 'bug-history' : 'bug-history-short',
        label: 'bug',
        assignment: 'bugs this repository already had, made again in this change',
        items: [],
        extraItems: [`${METHOD}\n\n  Past bugs:\n\n${formatPastBugs(bugs, format).replace(/^/gm, '  ')}`],
        reasoningExample:
            "Past bug [4]: a GitLab status-comment call swallowed the API error and returned undefined. The diff adds postBitbucketPromptReply at reply.ts:40 with a catch that only logs a warning; read the caller: the execution is still marked success. Reported, anchored to reply.ts:40, naming past bug [4].",
    };
}
