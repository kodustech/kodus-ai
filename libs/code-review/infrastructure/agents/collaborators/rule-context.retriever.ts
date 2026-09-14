/**
 * Declared-context retrieval for the Kody Rules shards (issue #1826).
 *
 * A rule states what it must see beyond the hunk; this module turns that
 * declaration into the smallest slice that answers it, deterministically. Code
 * decides what to fetch — the model never navigates — which is the same
 * property the sharded judge relies on for coverage.
 *
 * Two outcomes only, and both are explicit:
 *
 *   - the slice was retrieved, and the judge sees it;
 *   - it could not be retrieved, and the rule comes back in `unmet` so the
 *     caller skips it instead of judging it blind.
 *
 * There is no third "retrieved nothing, carry on" state for a need that failed:
 * a `RepoLookup` whose accessors throw is what makes an empty answer
 * distinguishable from an absent one, and that distinction is the whole point.
 */
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import {
    IKodyRule,
    KodyRuleContextNeed,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import { grepIsEmpty } from './repo-lookup';
import type { RepoLookup } from './repo-lookup';
import {
    DEFINITION_PATTERN,
    extractModifiedFunctionNames,
    getModifiedRanges,
} from './repo-slices';

/** One retrieved slice, as the shard prompt will render it. */
export interface RetrievedSlice {
    kind: KodyRuleContextNeed;
    /** Human-readable name of what this slice is, e.g. "occurrences of `formatDate`". */
    label: string;
    content: string;
    /** True when the per-shard budget cut this slice short (KRC-29). */
    truncated: boolean;
}

export interface ShardContext {
    slices: RetrievedSlice[];
    /** Rules whose declared need could not be satisfied — do not judge these. */
    unmet: Array<Partial<IKodyRule>>;
}

/**
 * Total retrieved characters per shard. Matches the per-rule reference budget
 * `inlineLoadedReferences` already applies, so retrieved context cannot
 * silently outweigh a rule's own cited files.
 */
export const SHARD_CONTEXT_BUDGET_CHARS = 6000;

/** How far the enclosing-scope resolver looks back for a definition line. */
const ENCLOSING_LOOKBACK_LINES = 120;
const ENCLOSING_TRAILING_LINES = 20;
/** Bounded window used when no enclosing scope can be resolved (KRC-27). */
const FALLBACK_WINDOW_RADIUS = 20;
const MAX_HUNKS_PER_FILE = 3;
const MAX_SYMBOLS_PER_FILE = 3;

/**
 * Upper bound on a whole-file read. `file-scope` compares the result against
 * the shard budget anyway; this only stops a pathological file (a lockfile, a
 * generated bundle) from being pulled across the sandbox boundary in full
 * before that comparison happens.
 */
const WHOLE_FILE_MAX_LINES = 4000;

/**
 * Where the scope around a hunk begins.
 *
 * NOT by keyword. This used to walk back to a line matching DEFINITION_PATTERN,
 * gated on an allowlist of extensions "whose definitions the pattern
 * recognises" — a per-language table in product code, and it was wrong the
 * moment a language declared functions with a word nobody had added. Kotlin's
 * `fun` was missing while `.kt` sat in the allowlist, so a Kotlin file was
 * PROMISED an enclosing scope and handed 120 arbitrary lines. Every language
 * outside the list had the same problem by construction, and the list can never
 * be finished: the product is language- and framework-agnostic.
 *
 * Indentation is the signal that is not per-language. A scope opens on the
 * nearest preceding line indented LESS than the hunk — in Python, in Go, in HCL
 * alike — because that is what indenting a body means. No table to maintain,
 * and a language nobody anticipated works the day someone reviews it.
 *
 * DEFINITION_PATTERN survives as a tie-breaker only: among the candidate lines
 * it prefers one that also reads like a definition, which sharpens the common
 * case without being required for the uncommon one.
 *
 * Returns null when there is nothing shallower to find — a hunk at top level,
 * or a file with no indentation at all (minified, generated, single-line). The
 * caller then says "window", not "scope": claiming a scope it did not find is
 * how a "this function is too long" rule gets a confident wrong answer.
 */
const indentWidthOf = (line: string): number => {
    const m = /^[ \t]*/.exec(line);
    return m ? m[0].length : 0;
};

function enclosingScopeStart(
    lines: string[],
    hunkStart: number,
    lookback: number,
): number | null {
    if (hunkStart < 1 || hunkStart > lines.length) return null;

    // The hunk's own depth, from its first non-blank line: a blank first line
    // would otherwise report depth 0 and swallow the whole file.
    let hunkIndent: number | null = null;
    for (
        let i = hunkStart;
        i <= Math.min(lines.length, hunkStart + 4);
        i++
    ) {
        if ((lines[i - 1] ?? '').trim()) {
            hunkIndent = indentWidthOf(lines[i - 1]);
            break;
        }
    }
    // Depth 0 means the change is already at top level; there is no enclosing
    // scope to show, and every line above would qualify.
    if (hunkIndent === null || hunkIndent === 0) return null;

    const floor = Math.max(1, hunkStart - lookback);
    for (let line = hunkStart - 1; line >= floor; line--) {
        const text = lines[line - 1] ?? '';
        if (!text.trim()) continue;
        if (indentWidthOf(text) >= hunkIndent) continue;
        return line;
    }
    return null;
}

/**
 * Needs this module retrieves, narrowest first. `diff-only` needs nothing and
 * `cited-file` is already served upstream by the reference inliners, so neither
 * appears here. The order is also the budget order: the narrower, more local
 * slice is spent first.
 */
const RETRIEVAL_ORDER: KodyRuleContextNeed[] = [
    'full-file',
    'symbol-references',
    'sibling-file',
];

/** Widest-need ordering for `resolveShardNeed`. */
const NEED_WIDTH: Record<KodyRuleContextNeed, number> = {
    'diff-only': 0,
    'cited-file': 1,
    // Wider than a cited file and narrower than anything that leaves the file:
    // it reaches the whole of ONE file and nothing beyond it.
    'full-file': 2,
    'sibling-file': 3,
    'symbol-references': 4,
};

/** Thrown by a retriever that cannot answer its need. */
class UnmetContextNeedError extends Error {}

/**
 * Needs that DEGRADE instead of skipping the rule when retrieval fails.
 *
 * Skipping is the right answer for a need that reaches OUTSIDE the file. A
 * "do not duplicate an existing helper" or "every endpoint has a test" rule
 * judged without the lookup has nothing to reason from and invents an answer —
 * that is #1724, and a rule silently skipped with a note on the PR is better
 * than a confident wrong comment.
 *
 * `full-file` is not like that, and treating it the same would be a
 * REGRESSION. The hunk is already a subset of the file, so a full-file rule
 * judged without its slice behaves exactly as every rule behaved before this
 * feature existed — and the claim checker still refutes whatever it asserts.
 * Skipping it would take a rule that works today out of enforcement the first
 * time a sandbox blinks. Degrading can only ever land back on today's
 * behaviour, so it cannot regress.
 */
const DEGRADES_INSTEAD_OF_SKIPPING = new Set<KodyRuleContextNeed>([
    'full-file',
]);

/**
 * A rule's declared need. Absent means `diff-only`: a rule saved before the
 * inference ran behaves exactly as it does today.
 */
export function needOf(rule: Partial<IKodyRule>): KodyRuleContextNeed {
    const declared = rule.contextNeed?.need;
    return declared && declared in NEED_WIDTH ? declared : 'diff-only';
}

/**
 * The widest need declared across a shard's rules. Two rules with different
 * needs share one shard, so the shard is built for the widest of them; the
 * narrower ones are covered by construction (KRC edge case: differing needs in
 * one shard).
 */
export function resolveShardNeed(
    rules: Array<Partial<IKodyRule>>,
): KodyRuleContextNeed {
    return rules.reduce<KodyRuleContextNeed>((widest, rule) => {
        const need = needOf(rule);
        return NEED_WIDTH[need] > NEED_WIDTH[widest] ? need : widest;
    }, 'diff-only');
}

const extensionOf = (filePath: string): string => {
    const dot = filePath.lastIndexOf('.');
    const slash = filePath.lastIndexOf('/');
    return dot > slash ? filePath.slice(dot) : '';
};

const isTestLikePath = (filePath: string): boolean =>
    /(^|\/)__tests__\//.test(filePath) ||
    /\.(spec|test)\.[^./]+$/.test(filePath) ||
    /_test\.[^./]+$/.test(filePath);

/**
 * The RAW unified diff, not `patchWithLinesStr`. The line-numbered variant
 * prefixes every line with its number BEFORE the '+', which stops
 * `extractModifiedFunctionNames` from recognizing a definition at all;
 * `getModifiedRanges` reads the `@@` headers, which both variants keep.
 */
const diffOf = (file: FileChange): string =>
    file.patch ?? (file as { patchWithLinesStr?: string }).patchWithLinesStr ?? '';

/**
 * Repository occurrences of the symbols this hunk defines (KRC-14).
 *
 * A hunk that defines no symbol leaves the need unanswerable: there is no
 * anchor to search on, so the rule is reported unmet rather than judged on the
 * hunk it explicitly said was not enough.
 */
async function retrieveSymbolReferences(
    file: FileChange,
    lookup: RepoLookup,
): Promise<RetrievedSlice[]> {
    const symbols = extractModifiedFunctionNames([
        { filename: file.filename, patch: diffOf(file) },
    ])
        .map((symbol) => symbol.name)
        .slice(0, MAX_SYMBOLS_PER_FILE);

    if (symbols.length === 0) {
        throw new UnmetContextNeedError(
            'the hunk defines no symbol to search the repository for',
        );
    }

    const slices: RetrievedSlice[] = [];
    for (const symbol of symbols) {
        const raw = await lookup.grep(symbol);
        // `grepIsEmpty` covers BOTH provider shapes. Testing truthiness alone
        // let E2B's "No matches found." through as if it were a slice of the
        // repository, so the model was shown that sentence instead of the one
        // this code writes for a real absence.
        const found = grepIsEmpty(raw) ? '' : raw.trim();
        slices.push({
            kind: 'symbol-references',
            label: `repository occurrences of \`${symbol}\``,
            content: found || '(no occurrence anywhere in the repository)',
            truncated: false,
        });
    }
    return slices;
}

/**
 * The rest of the file the hunk lives in (KRC / issue #1826, the "majority" row).
 *
 * Two shapes, and which one is used is decided by SIZE, never by language:
 *
 *   fits the budget  -> the file, whole. Nothing is more accurate, and for the
 *                       common file it is also the cheapest thing to reason about.
 *   over the budget  -> the scope ENCLOSING each hunk. "Is this function too
 *                       long" and "does this class have a docstring" are answered
 *                       by the scope the change sits in; the far end of a 4,000
 *                       line file is not evidence about them.
 *
 * The earlier attempt attached the whole file to every shard and OMITTED it
 * whenever it did not fit, so the biggest files — the ones where "too long"
 * actually bites — were exactly the ones that got nothing. Degrading to the
 * enclosing scope inverts that: the bigger the file, the more the narrowing
 * matters, and something true is always delivered.
 *
 * The slice is marked `truncated` when it is the narrowed form, so the prompt
 * tells the model it is looking at part of a file rather than all of it.
 */
async function retrieveFullFile(
    file: FileChange,
    lookup: RepoLookup,
    budgetChars: number,
): Promise<RetrievedSlice[]> {
    const whole = await lookup.read(file.filename, 1, WHOLE_FILE_MAX_LINES);
    const text = whole ?? '';
    if (!text.trim()) {
        throw new UnmetContextNeedError(
            'the file came back empty from the repository',
        );
    }

    if (text.length <= budgetChars) {
        return [
            {
                kind: 'full-file',
                label: `the whole of ${file.filename}`,
                content: text,
                truncated: false,
            },
        ];
    }

    // Over budget: narrow to the scope around each hunk.
    const lines = text.split('\n');
    const ranges = getModifiedRanges(diffOf(file)).slice(0, MAX_HUNKS_PER_FILE);
    if (ranges.length === 0) {
        throw new UnmetContextNeedError(
            'the file is over the context budget and its diff names no line range to narrow to',
        );
    }

    const slices: RetrievedSlice[] = [];

    for (const [start, end] of ranges) {
        let from: number;
        let to: number;
        const scopeStart = enclosingScopeStart(
            lines,
            start,
            ENCLOSING_LOOKBACK_LINES,
        );
        const foundScope = scopeStart !== null;
        if (foundScope) {
            from = scopeStart;
            to = Math.min(lines.length, end + ENCLOSING_TRAILING_LINES);
        } else {
            // KRC-27: nothing shallower to anchor on, so an honest bounded
            // window rather than a confident wrong "enclosing scope".
            from = Math.max(1, start - FALLBACK_WINDOW_RADIUS);
            to = Math.min(lines.length, end + FALLBACK_WINDOW_RADIUS);
        }

        // Say which of the two this actually is. Calling a window "the scope"
        // tells the model it is looking at a whole function when it is looking
        // at 120 arbitrary lines — precisely how a "this function is too long"
        // rule gets a confidently wrong answer.
        const label = foundScope
            ? `${file.filename}, lines ${from}-${to} of ${lines.length} (the scope enclosing one hunk; the file is too large to show whole)`
            : `${file.filename}, lines ${from}-${to} of ${lines.length} (a window around one hunk — no enclosing definition was found, so this may start mid-scope; the file is too large to show whole)`;

        slices.push({
            kind: 'full-file',
            label,
            content: lines.slice(from - 1, to).join('\n'),
            truncated: true,
        });
    }

    return slices;
}

/**
 * Companion test paths for a source file. This is the sibling shape rules of
 * the "every new endpoint has a test" family are about, and it is the only one
 * derivable from the changed file alone.
 */
function siblingCandidates(filename: string): string[] {
    const ext = extensionOf(filename);
    if (!ext || isTestLikePath(filename)) return [];

    const slash = filename.lastIndexOf('/');
    const dir = slash < 0 ? '' : filename.slice(0, slash + 1);
    const base = filename.slice(slash + 1, filename.length - ext.length);

    return [
        `${dir}${base}.spec${ext}`,
        `${dir}${base}.test${ext}`,
        `${dir}${base}_test${ext}`,
        `${dir}__tests__/${base}${ext}`,
    ];
}

/**
 * Whether the expected sibling path exists, and whether this PR changed it
 * (KRC-26).
 */
async function retrieveSiblingFile(
    file: FileChange,
    lookup: RepoLookup,
    changedFilenames: string[],
): Promise<RetrievedSlice[]> {
    const candidates = siblingCandidates(file.filename);
    // The file is itself a test, or carries no extension to build a companion
    // path from: there is no sibling to report on, and nothing is hidden.
    if (candidates.length === 0) return [];

    const changed = new Set(changedFilenames);
    const lines: string[] = [];
    for (const candidate of candidates) {
        const exists = await lookup.exists(candidate);
        lines.push(
            `- ${candidate}: ${exists ? 'exists' : 'does not exist'}${
                changed.has(candidate) ? ', changed by this PR' : ''
            }`,
        );
    }

    return [
        {
            kind: 'sibling-file',
            label: `companion files of ${file.filename}`,
            content: lines.join('\n'),
            truncated: false,
        },
    ];
}

/**
 * Cap the shard's total retrieved text. Over budget, the slice is cut and
 * MARKED — never dropped, and never at the cost of skipping the rule (KRC-29).
 */
function applyBudget(
    slices: RetrievedSlice[],
    budgetChars: number,
): RetrievedSlice[] {
    let used = 0;
    return slices.map((slice) => {
        const remaining = Math.max(0, budgetChars - used);
        if (slice.content.length <= remaining) {
            used += slice.content.length;
            return slice;
        }
        used = budgetChars;
        return {
            ...slice,
            content: slice.content.slice(0, remaining),
            truncated: true,
        };
    });
}

export interface RetrieveForShardArgs {
    file: FileChange;
    rules: Array<Partial<IKodyRule>>;
    lookup: RepoLookup;
    /** Every filename this PR touched, for the sibling-file "and was it changed?" half. */
    changedFilenames?: string[];
    budgetChars?: number;
    logger?: { warn: (entry: any) => void };
    /**
     * True when the caller has ALREADY put this file's full text on the shard
     * prompt (issue #1826, step 1 — which is unconditional and ungated).
     *
     * When it is, retrieving `full-file` here is pure duplication: under the
     * shard budget the slice is a byte-identical second copy of the file, and
     * over it the narrowed scope is a strict subset of text already on the
     * page. Measured before this flag existed: a 40-line file appeared 81
     * times as its own marker in one prompt — two whole copies plus the diff.
     *
     * So the need is satisfied by the file already being there. It still
     * changes the prompt, via the authorization the judge derives from the
     * rule itself; it just stops costing a lookup and a second copy.
     */
    wholeFileAlreadyOnPage?: boolean;
}

/**
 * Retrieve everything this shard's rules declared they need.
 *
 * Slices are retrieved once per distinct need, not once per rule, so two rules
 * declaring the same need share one lookup. A need whose retrieval fails takes
 * only the rules that declared it into `unmet`; the rest of the shard is
 * unaffected.
 */
export async function retrieveForShard(
    args: RetrieveForShardArgs,
): Promise<ShardContext> {
    const {
        file,
        rules,
        lookup,
        changedFilenames = [],
        budgetChars = SHARD_CONTEXT_BUDGET_CHARS,
        logger,
        wholeFileAlreadyOnPage = false,
    } = args;

    const declared = new Set(rules.map(needOf));
    const wanted = RETRIEVAL_ORDER.filter((need) => declared.has(need));
    if (wanted.length === 0) return { slices: [], unmet: [] };

    // A file this PR ADDED is already whole inside the diff, so there is
    // nothing outside it to retrieve and nothing to skip the rule over.
    if (file.status === 'added') return { slices: [], unmet: [] };

    const failed = new Set<KodyRuleContextNeed>();
    const collected: RetrievedSlice[] = [];

    for (const need of wanted) {
        try {
            if (need === 'full-file') {
                // Already satisfied — the caller put the file on the page.
                // Not `unmet`: the need is MET, by cheaper means.
                if (wholeFileAlreadyOnPage) continue;
                collected.push(
                    ...(await retrieveFullFile(file, lookup, budgetChars)),
                );
            } else if (need === 'symbol-references') {
                collected.push(
                    ...(await retrieveSymbolReferences(file, lookup)),
                );
            } else {
                collected.push(
                    ...(await retrieveSiblingFile(file, lookup, changedFilenames)),
                );
            }
        } catch (err) {
            const degrades = DEGRADES_INSTEAD_OF_SKIPPING.has(need);
            if (!degrades) failed.add(need);
            logger?.warn({
                message: `[rule-context] could not retrieve ${need} for ${file.filename}; ${degrades ? 'the rules that need it are judged on the diff alone, as they were before this feature' : 'the rules that need it will not be judged'}: ${err instanceof Error ? err.message : String(err)}`,
                context: 'rule-context-retriever',
                metadata: {
                    filename: file.filename,
                    need,
                    degraded: DEGRADES_INSTEAD_OF_SKIPPING.has(need),
                    lookupAvailable: lookup.available,
                    unavailableReason: lookup.unavailableReason,
                },
            });
        }
    }

    return {
        slices: applyBudget(collected, budgetChars),
        unmet: rules.filter((rule) => failed.has(needOf(rule))),
    };
}
