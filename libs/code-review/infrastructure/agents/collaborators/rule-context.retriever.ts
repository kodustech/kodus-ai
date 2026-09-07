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
 * Extensions whose definitions `DEFINITION_PATTERN` actually recognizes. A file
 * outside this set gets the bounded window instead of a wrong "enclosing scope"
 * — the fallback KRC-27 requires.
 */
const ENCLOSING_SCOPE_EXTENSIONS = new Set([
    '.c',
    '.cc',
    '.cpp',
    '.cs',
    '.go',
    '.java',
    '.js',
    '.jsx',
    '.kt',
    '.php',
    '.py',
    '.rb',
    '.rs',
    '.scala',
    '.swift',
    '.ts',
    '.tsx',
]);

/**
 * Needs this module retrieves, narrowest first. `diff-only` needs nothing and
 * `cited-file` is already served upstream by the reference inliners, so neither
 * appears here. The order is also the budget order: the narrower, more local
 * slice is spent first.
 */
const RETRIEVAL_ORDER: KodyRuleContextNeed[] = [
    'enclosing-scope',
    'symbol-references',
    'sibling-file',
];

/** Widest-need ordering for `resolveShardNeed`. */
const NEED_WIDTH: Record<KodyRuleContextNeed, number> = {
    'diff-only': 0,
    'cited-file': 1,
    'sibling-file': 2,
    'enclosing-scope': 3,
    'symbol-references': 4,
};

/** Thrown by a retriever that cannot answer its need. */
class UnmetContextNeedError extends Error {}

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

const diffOf = (file: FileChange): string =>
    (file as { patchWithLinesStr?: string }).patchWithLinesStr ??
    file.patch ??
    '';

/**
 * The enclosing function or class of each changed hunk (KRC-13), falling back
 * to a bounded window around the hunk when the file's language has no
 * definition shape we recognize (KRC-27).
 */
async function retrieveEnclosingScope(
    file: FileChange,
    lookup: RepoLookup,
): Promise<RetrievedSlice[]> {
    const ranges = getModifiedRanges(diffOf(file)).slice(0, MAX_HUNKS_PER_FILE);
    if (ranges.length === 0) return [];

    const resolvable = ENCLOSING_SCOPE_EXTENSIONS.has(
        extensionOf(file.filename),
    );
    const slices: RetrievedSlice[] = [];

    for (const [start, end] of ranges) {
        if (resolvable) {
            const from = Math.max(1, start - ENCLOSING_LOOKBACK_LINES);
            const content = await lookup.read(
                file.filename,
                from,
                end + ENCLOSING_TRAILING_LINES,
            );
            const lines = content.split('\n');
            // Last definition line at or above the hunk start, i.e. the scope
            // the change sits inside.
            let openedAt = -1;
            for (let i = 0; i < lines.length && from + i <= start; i++) {
                if (DEFINITION_PATTERN.test(lines[i])) openedAt = i;
            }
            if (openedAt >= 0) {
                slices.push({
                    kind: 'enclosing-scope',
                    label: `${file.filename}: scope enclosing the change at line ${start}, from line ${from + openedAt}`,
                    content: lines.slice(openedAt).join('\n'),
                    truncated: false,
                });
                continue;
            }
        }

        const from = Math.max(1, start - FALLBACK_WINDOW_RADIUS);
        const to = end + FALLBACK_WINDOW_RADIUS;
        slices.push({
            kind: 'enclosing-scope',
            label: `${file.filename}: lines ${from}-${to} around the change (no enclosing scope resolved for this file type)`,
            content: await lookup.read(file.filename, from, to),
            truncated: false,
        });
    }

    return slices;
}

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
        const found = (await lookup.grep(symbol)).trim();
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
            if (need === 'enclosing-scope') {
                collected.push(...(await retrieveEnclosingScope(file, lookup)));
            } else if (need === 'symbol-references') {
                collected.push(
                    ...(await retrieveSymbolReferences(file, lookup)),
                );
            } else {
                collected.push(
                    ...(await retrieveSiblingFile(
                        file,
                        lookup,
                        changedFilenames,
                    )),
                );
            }
        } catch (err) {
            failed.add(need);
            logger?.warn({
                message: `[rule-context] could not retrieve ${need} for ${file.filename}; the rules that need it will not be judged: ${err instanceof Error ? err.message : String(err)}`,
                context: 'rule-context-retriever',
                metadata: {
                    filename: file.filename,
                    need,
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
