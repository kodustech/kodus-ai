import { estimateTextTokens } from '@libs/llm/token-estimate';

/**
 * Tokens of diff text, for a budget it must never exceed: what the tokenizer
 * can't encode (an inline base64 image, a minified line) counts one token per
 * character instead of three.
 */
const diffTokens = (text: string) =>
    estimateTextTokens(text, { worstCase: true });

/** A changed file as the code hosts return it. */
export interface ChangedFile {
    filename: string;
    status?: string;
    patch?: string;
}

/** The PR's patches in one text, the way the judge reads them. Files without a patch are left out. */
export function formatPullRequestDiff(
    files: ChangedFile[] | undefined,
): string {
    return (files ?? [])
        .filter((file) => typeof file.patch === 'string' && file.patch.trim())
        .map(
            (file) =>
                `=== FILE: ${file.filename} ===\nStatus: ${file.status ?? 'modified'}\n\n${file.patch}`,
        )
        .join('\n\n');
}

/**
 * The most diff one judge call carries, whatever the model holds: the cost
 * ceiling. A model with a smaller window gets less (see `DiffBudget.tokens`).
 */
export const DIFF_BUDGET_CHARS = 200_000;

/**
 * How much diff fits: `chars` bounds the cost, `tokens` the model's input
 * window. Characters alone can't stand for tokens: an SVG patch ran at about
 * 1.3 characters per token (#2233), so 200k characters of it is ~155k tokens.
 */
export interface DiffBudget {
    chars: number;
    /** Absent: no window to respect beyond `chars`. */
    tokens?: number;
}

const FILE_HEADER = /^(?:=== FILE: (.+?) ===|diff --git a\/\S+ b\/(\S+))$/gm;

/**
 * The diff the judge can read whole, and the files it had to leave out. Files
 * are kept in order; one that doesn't fit is skipped so smaller ones after it
 * still get in. A requirement that may live in a skipped file becomes CHECK
 * MANUALLY instead of MISSING (UC-32).
 */
export function fitDiff(
    diff: string,
    budget: number | DiffBudget = DIFF_BUDGET_CHARS,
): { diff: string; unseenFiles: string[] } {
    const { chars, tokens = Infinity } =
        typeof budget === 'number' ? { chars: budget } : budget;
    const tokensOf = (text: string) =>
        tokens === Infinity ? 0 : diffTokens(text);

    if (diff.length <= chars && tokensOf(diff) <= tokens) {
        return { diff, unseenFiles: [] };
    }
    const chunks = fileChunks(diff);
    if (!chunks.length) {
        return {
            diff: cutToTokens(diff.slice(0, chars), tokens),
            unseenFiles: ['(rest of the diff)'],
        };
    }
    const kept: string[] = [];
    const unseenFiles: string[] = [];
    let used = 0;
    let usedTokens = 0;
    for (const chunk of chunks) {
        // The character check first: it is free, and it keeps a huge file
        // from being tokenized only to be left out.
        const withinChars = used + chunk.text.length <= chars;
        const count = withinChars ? tokensOf(chunk.text) : 0;
        if (withinChars && usedTokens + count <= tokens) {
            kept.push(chunk.text);
            used += chunk.text.length;
            usedTokens += count;
        } else {
            unseenFiles.push(chunk.file);
        }
    }
    return { diff: kept.join(''), unseenFiles };
}

/** A text without file headers, shortened until it is within `tokens`. */
function cutToTokens(text: string, tokens: number): string {
    let cut = text;
    for (let i = 0; i < 4 && tokens !== Infinity; i++) {
        const count = diffTokens(cut);
        if (count <= tokens) {
            return cut;
        }
        cut = cut.slice(0, Math.floor((cut.length * tokens * 0.95) / count));
    }
    return tokens === Infinity || diffTokens(cut) <= tokens ? cut : '';
}

/**
 * The tokens left for the diff in one judge call: the model's input window,
 * less a safety margin, the answer it may write, and everything else the call
 * carries (instructions, task, PR description, the names of files left out).
 * Zero when nothing is left: the judge then reads no diff and says which
 * files it could not see, rather than the provider rejecting the call.
 */
export function diffTokenBudget(params: {
    contextWindowTokens: number;
    /** Every token of the call that is not the diff. */
    promptTokens: number;
    outputTokens: number;
}): number {
    const usable = Math.floor(
        params.contextWindowTokens * (1 - WINDOW_SAFETY_MARGIN),
    );
    return Math.max(0, usable - params.promptTokens - params.outputTokens);
}

/**
 * The counter is o200k_base, not every provider's tokenizer: this much of the
 * window is kept for the difference.
 */
const WINDOW_SAFETY_MARGIN = 0.1;

/** The files the diff changes, in order. */
export function changedFileNames(diff: string): string[] {
    return fileChunks(diff).map((chunk) => chunk.file);
}

/** One file's part of the diff, header included. */
function fileChunks(diff: string): Array<{ file: string; text: string }> {
    const headers = [...diff.matchAll(FILE_HEADER)];
    return headers.map((header, i) => ({
        file: header[1] ?? header[2],
        text: diff.slice(
            header.index,
            i + 1 < headers.length ? headers[i + 1].index : diff.length,
        ),
    }));
}

/**
 * About 6k tokens: what one second look at a requirement re-reads on every
 * step. The agent reads any other file with `read_file`.
 */
export const GAP_DIFF_CHARS = 24_000;

/**
 * The diff for a second look at one requirement: whole when it is small;
 * otherwise the files its evidence cites first, then the ones that share the
 * most words with the requirement (a MISSING one rarely cites any), while
 * they fit, and the names of the rest for `read_file`. A file too large for
 * the room left is cut, not dropped. Sent on every step of up to eight
 * checks, the whole diff of a large PR cost millions of tokens a run.
 */
export function diffFor(
    diff: string,
    focus: { files?: string[]; requirement?: string },
    budget: number | DiffBudget = GAP_DIFF_CHARS,
): string {
    const { chars, tokens } =
        typeof budget === 'number' ? { chars: budget } : budget;
    let room = chars;
    let picked = diffWithin(diff, focus, room);
    // Shrink the character room until the pick is within the model's tokens:
    // the pick keeps its order and its list of files left out.
    for (let i = 0; i < 4 && tokens !== undefined; i++) {
        const count = diffTokens(picked);
        if (count <= tokens) {
            return picked;
        }
        room = Math.floor((room * tokens * 0.95) / count);
        picked = room > 0 ? diffWithin(diff, focus, room) : '';
    }
    return tokens === undefined || diffTokens(picked) <= tokens ? picked : '';
}

function diffWithin(
    diff: string,
    focus: { files?: string[]; requirement?: string },
    budget: number,
): string {
    if (diff.length <= budget) {
        return diff;
    }
    const chunks = fileChunks(diff);
    if (!chunks.length) {
        return `${diff.slice(0, budget)}\n… (cut)`;
    }
    const cited = new Set(focus.files ?? []);
    const terms = requirementTerms(focus.requirement ?? '');
    const score = (chunk: { file: string; text: string }) => {
        const text = chunk.text.toLowerCase();
        return terms.filter((term) => text.includes(term)).length;
    };
    const ordered = [
        ...chunks.filter((c) => cited.has(c.file)),
        ...chunks
            .filter((c) => !cited.has(c.file))
            .map((chunk, at) => ({ chunk, at, score: score(chunk) }))
            .sort((a, b) => b.score - a.score || a.at - b.at)
            .map(({ chunk }) => chunk),
    ];
    const kept: string[] = [];
    const left: string[] = [];
    const room = Math.min(OMITTED_FILES_CHARS, Math.floor(budget / 10));
    let used = room;
    for (const chunk of ordered) {
        const free = budget - used;
        if (chunk.text.length <= free) {
            kept.push(chunk.text);
            used += chunk.text.length;
        } else if (free >= MIN_CUT_CHARS) {
            const cut = `\n… (cut: read the rest of ${chunk.file} with read_file)\n`;
            kept.push(chunk.text.slice(0, free - cut.length) + cut);
            used = budget;
        } else {
            left.push(chunk.file);
        }
    }
    return left.length
        ? `${kept.join('')}${omittedFiles(left, room)}`
        : kept.join('');
}

/** Less room than this left for a file, and it is only named. */
const MIN_CUT_CHARS = 1_500;

/**
 * The requirement's words worth looking for in a file, longer than three
 * letters, without their last two past five ("exported" finds `export`,
 * "invoices" finds `invoice`).
 */
function requirementTerms(requirement: string): string[] {
    return [
        ...new Set(
            requirement
                .toLowerCase()
                .split(/[^\p{L}\p{N}]+/u)
                .filter((word) => word.length > 3)
                .map((word) => (word.length > 5 ? word.slice(0, -2) : word)),
        ),
    ];
}

/** Most room kept for the names of the files left out, so the whole stays in budget. */
const OMITTED_FILES_CHARS = 2_000;

/** The files left out, by name, cut to the room kept for them. */
function omittedFiles(files: string[], room: number): string {
    const head =
        '\n\nAlso changed, not shown here (read them with read_file): ';
    let list = '';
    for (const [i, file] of files.entries()) {
        const more = `, … and ${files.length - i} more`;
        const next = `${list ? ', ' : ''}${file}`;
        if (head.length + list.length + next.length + more.length > room) {
            return `${head}${list}${more}`;
        }
        list += next;
    }
    return `${head}${list}`;
}
