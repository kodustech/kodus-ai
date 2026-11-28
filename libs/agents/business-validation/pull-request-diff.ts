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

/** What `fitDiff` names as left out of a diff with no file headers. */
export const REST_OF_THE_DIFF = '(rest of the diff)';

const FILE_HEADER = /^(?:=== FILE: (.+?) ===|diff --git a\/\S+ b\/(\S+))$/gm;

/**
 * How late a file takes the diff budget: code first, then data and config,
 * then what carries no business rule (fixtures, snapshots, assets, lockfiles,
 * minified or generated files). In path order a 24k window spent itself on
 * `fixtures/students.min.json` and left `src/enrollment/fee.service.ts`
 * unread (#2233 QA).
 */
export function readingTier(file: string): 0 | 1 | 2 {
    if (NO_BUSINESS_RULE.test(file)) return 2;
    if (DATA_FILE.test(file)) return 1;
    return 0;
}

const NO_BUSINESS_RULE =
    /(?:^|\/)(?:fixtures?|__fixtures__|__snapshots__|__mocks__|testdata|test-data|vendor|dist|generated)\/|\.(?:min\.[a-z]+|map|snap|lock|svg|png|jpe?g|gif|ico|webp|bmp|pdf|woff2?|ttf|otf|eot|mp[34]|zip|gz)$|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|go\.sum)$/i;

const DATA_FILE = /\.(?:json|ya?ml|csv|tsv|xml|toml|txt|md)$/i;

/**
 * The diff the judge can read whole, and the files it had to leave out. Files
 * take the budget by `readingTier`, in order within a tier, and are shown in
 * their order in the PR; one that doesn't fit is skipped so smaller ones
 * after it still get in. A requirement that may live in a skipped file
 * becomes CHECK MANUALLY instead of MISSING (UC-32). `cutByTokens`: the
 * model's window, not the character cap, kept something out.
 */
export function fitDiff(
    diff: string,
    budget: number | DiffBudget = DIFF_BUDGET_CHARS,
): { diff: string; unseenFiles: string[]; cutByTokens: boolean } {
    const { chars, tokens = Infinity } =
        typeof budget === 'number' ? { chars: budget } : budget;
    const tokensOf = (text: string) =>
        tokens === Infinity ? 0 : diffTokens(text);

    if (diff.length <= chars && tokensOf(diff) <= tokens) {
        return { diff, unseenFiles: [], cutByTokens: false };
    }
    const chunks = fileChunks(diff);
    if (!chunks.length) {
        const byChars = sliceWhole(diff, chars);
        const cut = cutToTokens(byChars, tokens);
        return {
            diff: cut,
            unseenFiles: [REST_OF_THE_DIFF],
            cutByTokens: cut !== byChars,
        };
    }
    const keptAt = new Set<number>();
    const unseenFiles: string[] = [];
    let used = 0;
    let usedTokens = 0;
    let cutByTokens = false;
    const byTier = chunks
        .map((chunk, at) => ({ chunk, at, tier: readingTier(chunk.file) }))
        // A stable sort: the PR's order stays within a tier.
        .sort((a, b) => a.tier - b.tier);
    for (const { chunk, at } of byTier) {
        // The character check first: it is free, and it keeps a huge file
        // from being tokenized only to be left out.
        // Nor is a file tokenized once the tokens are spent: on a small
        // window an asset-heavy PR would tokenize every file it can't keep.
        const withinChars = used + chunk.text.length <= chars;
        const room =
            withinChars &&
            usedTokens < tokens &&
            !exceedsByPrefix(chunk.text, tokens - usedTokens);
        const count = room ? tokensOf(chunk.text) : 0;
        if (room && usedTokens + count <= tokens) {
            keptAt.add(at);
            used += chunk.text.length;
            usedTokens += count;
        } else {
            unseenFiles.push(chunk.file);
            cutByTokens ||= withinChars;
        }
    }
    const order = new Map(chunks.map((chunk, at) => [chunk.file, at]));
    return {
        diff: chunks
            .filter((_, at) => keptAt.has(at))
            .map((chunk) => chunk.text)
            .join(''),
        unseenFiles: unseenFiles.sort(
            (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
        ),
        cutByTokens,
    };
}

/**
 * Whether a text can't fit `remaining` tokens, judged from a prefix: a file
 * far longer than the room left is counted only as far as it takes to know
 * (17 SVGs of 150k characters took 1.4s to leave out at a 1,000-token budget).
 * A prefix with more tokens than the room means the whole has more too, so
 * the answer is right whatever the probe's length; the length only sets the
 * cost. A short probe settles dense text (SVG, base64), a longer one code.
 */
function exceedsByPrefix(text: string, remaining: number): boolean {
    if (remaining === Infinity) {
        return false;
    }
    for (const charsPerToken of PROBE_CHARS_PER_TOKEN) {
        const probe = remaining * charsPerToken;
        if (text.length <= probe) {
            return false;
        }
        if (diffTokens(sliceWhole(text, probe)) > remaining + 1) {
            return true;
        }
    }
    return false;
}

/** The probes' lengths, in characters per token of room left. */
const PROBE_CHARS_PER_TOKEN = [2, 6];

/** A text without file headers, shortened until it is within `tokens`. */
function cutToTokens(text: string, tokens: number): string {
    let cut = text;
    for (let i = 0; i < SHRINK_STEPS && tokens !== Infinity; i++) {
        const count = diffTokens(cut);
        if (count <= tokens) {
            return cut;
        }
        cut = sliceWhole(cut, Math.floor((cut.length * tokens * 0.9) / count));
    }
    return tokens === Infinity || diffTokens(cut) <= tokens ? cut : '';
}

/** Shrinks before giving up: each step cuts in proportion, then 10% more. */
const SHRINK_STEPS = 8;

/**
 * The first `end` characters, without splitting a surrogate pair: a lone
 * high surrogate is invalid in the JSON body, and Anthropic rejects it.
 */
export function sliceWhole(text: string, end: number): string {
    if (end <= 0) {
        return '';
    }
    if (end >= text.length) {
        return text;
    }
    const last = text.charCodeAt(end - 1);
    return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
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
 * window is kept for the difference. Tokenizers that split every digit (Qwen,
 * Gemini's SentencePiece) count a digit-heavy SVG about 1.10x what o200k
 * does, so 10% was not enough.
 */
const WINDOW_SAFETY_MARGIN = 0.15;

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
    // the pick keeps its order and its list of files left out. The room
    // starts from what was picked: a diff under the cap is shorter than it.
    for (let i = 0; i < SHRINK_STEPS && tokens !== undefined; i++) {
        const count = diffTokens(picked);
        if (count <= tokens) {
            return picked;
        }
        room = Math.floor(
            (Math.min(room, picked.length) * tokens * 0.9) / count,
        );
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
        return `${sliceWhole(diff, budget)}\n… (cut)`;
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
            kept.push(sliceWhole(chunk.text, free - cut.length) + cut);
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
