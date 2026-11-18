/**
 * #2097: one problem keeps one thread for the life of the PR. Before a
 * finding is posted, it is compared with the comments Kody already posted on
 * this PR in earlier rounds. The finder and the rule judge see those comments
 * too, but a prompt only holds when the model reasons, and it sees only the
 * 40 most recent; this check reads the whole history. For Kody Rules it owns
 * the decision; the bug finder keeps its own instruction never to repeat, and
 * this check catches what gets past it.
 *
 * A finding that raises the SAME OCCURRENCE as an earlier comment is not
 * posted, whatever that comment's status: the earlier thread is the reminder.
 * A stored "implemented" does not change that — the check sees the earlier
 * comment and today's code, never whether the code was right in between, so
 * a fix that came back looks the same as one that was never complete. A new
 * place or a different problem is posted.
 *
 * Shared with `evals/review-rounds`, so the eval runs the check production
 * runs.
 */
import { jsonSchema } from 'ai';

import type { PrDecisionRecord } from '@libs/code-review/domain/contracts/pr-decision-store.contract';
import type { LangfuseTelemetryMetadata } from '@libs/core/log/langfuse';
import { createLogger } from '@libs/core/log/logger';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { LLM } from '@libs/llm/llm';
import { hasManagedModelKey } from '@libs/llm/managed-slot';
import { normalizeEnvelope } from '@libs/llm/structured-output-repair';

import { contentSimilarity } from './dedup-prompt';

const logger = createLogger('RepeatCheck');

export interface RepeatCheckFinding {
    label?: string;
    brokenKodyRulesIds?: string[];
    relevantFile?: string;
    relevantLinesStart?: number;
    relevantLinesEnd?: number;
    existingCode?: string;
    oneSentenceSummary?: string;
    suggestionContent?: string;
    revisesSuggestionId?: string;
}

export interface RepeatOf<T> {
    finding: T;
    earlier: PrDecisionRecord;
    /** `code`: same rule, same file, same code. `model`: the model's call. */
    by: 'code' | 'model';
}

export interface RepeatCheckResult<T> {
    /** To post. */
    kept: T[];
    /** Not posted: an earlier comment already raised them. */
    repeats: RepeatOf<T>[];
    /** Plausible repeats without a verdict. These did not become comments. */
    withheld: T[];
    /** Kept findings the model identified as caused by an earlier suggestion. */
    revisions: Array<{ finding: T; earlier: PrDecisionRecord }>;
    model: 'not-needed' | 'ok' | 'failed' | 'no-model';
}

export interface RepeatCheckOptions {
    organizationId: string;
    byokConfig?: NormalizedModel;
    /** Renders a rule finding's or entry's rule by title. */
    ruleTitleByUuid?: ReadonlyMap<string, string>;
    telemetryMetadata?: LangfuseTelemetryMetadata;
    prNumber?: number;
}

/** Earlier comments shown per finding, most recent first. */
const MAX_CANDIDATES = 12;
/** Findings per model call; batches run in parallel and fail independently. */
const BATCH_SIZE = 10;
const MAX_TEXT = 600;
const MAX_CODE = 400;
/** A shorter code text matches too much to identify one occurrence. */
const MIN_CODE_MATCH = 8;
/** Earlier comments on other files whose text is this close also go to the
 *  model: code that moved and changed has no other link to its comment. On
 *  the review-rounds cases, a moved repeat scored 0.33 and unrelated comments
 *  stayed under 0.08. */
const MIN_TEXT_SIMILARITY = 0.15;
const MAX_SIMILAR_CANDIDATES = 4;
const REPEAT_CHECK_TIMEOUT_MS = 120_000;
const RETRY_BATCH_SIZE = 3;
const RETRY_TIMEOUT_MS = 25_000;

const normalizePath = (path?: string) =>
    (path || '').trim().replace(/^\.?\//, '');

const normalizeCode = (code?: string) =>
    (code || '').replace(/\s+/g, ' ').trim();

const clip = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max)}…` : text;

const isRule = (f: { label?: string }) => f.label === 'kody_rules';

const sharesRule = (f: RepeatCheckFinding, earlier: PrDecisionRecord) =>
    (f.brokenKodyRulesIds ?? []).some((id) =>
        (earlier.brokenKodyRulesIds ?? []).includes(id),
    );

/** A comment about one Kody Rule never covers another rule (the contract of
 *  `brokenKodyRulesIds`), even on the same lines. */
const otherRule = (f: RepeatCheckFinding, earlier: PrDecisionRecord) =>
    isRule(f) && isRule(earlier) && !sharesRule(f, earlier);

/** A bug finding the finder linked to an earlier comment is, by the finder's
 *  account, a different problem that comment caused — the finder is told
 *  never to raise an entry again, and the link is right for bug findings
 *  (#2097: 112 of 119). Judged against the others, never against that one. A
 *  rule finding's link is not trusted: rule reposts carry it too. */
const linkedByFinder = (f: RepeatCheckFinding, earlier: PrDecisionRecord) =>
    !isRule(f) &&
    !!f.revisesSuggestionId &&
    f.revisesSuggestionId === earlier.suggestionId;

/** Earlier comments that could be the same occurrence: same file, same rule
 *  anywhere (code moves between files), the same code anywhere, or close in
 *  text. */
export function repeatCandidates(
    finding: RepeatCheckFinding,
    history: readonly PrDecisionRecord[],
): PrDecisionRecord[] {
    const file = normalizePath(finding.relevantFile);
    const code = normalizeCode(finding.existingCode);
    const comparable = history.filter(
        (earlier) =>
            !otherRule(finding, earlier) && !linkedByFinder(finding, earlier),
    );
    const linked = comparable.filter(
        (earlier) =>
            (!!file && normalizePath(earlier.relevantFile) === file) ||
            sharesRule(finding, earlier) ||
            (code.length >= MIN_CODE_MATCH &&
                normalizeCode(earlier.existingCode) === code),
    );
    const similar = comparable
        .filter((earlier) => !linked.includes(earlier))
        .map((earlier) => ({
            earlier,
            score: contentSimilarity(finding, {
                suggestionContent: earlier.suggestionContent,
            }),
        }))
        .filter(({ score }) => score >= MIN_TEXT_SIMILARITY)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_SIMILAR_CANDIDATES)
        .map(({ earlier }) => earlier);
    return [...linked.slice(0, MAX_CANDIDATES), ...similar];
}

/** The keys under which the same rule on the same code in the same file
 *  meet: the same occurrence, without asking a model. Keyed on the rule ids,
 *  not the label: a stored entry's label and rule ids are set apart. */
export function occurrenceKeys(entry: {
    brokenKodyRulesIds?: readonly string[];
    relevantFile?: string;
    existingCode?: string;
}): string[] {
    const file = normalizePath(entry.relevantFile);
    const code = normalizeCode(entry.existingCode);
    if (!file || code.length < MIN_CODE_MATCH) return [];
    return (entry.brokenKodyRulesIds ?? []).map(
        (ruleId) => `${ruleId}\u0000${file}\u0000${code}`,
    );
}

export const REPEAT_VERDICTS = [
    'same_occurrence',
    'new_place',
    'caused_by_earlier',
    'different_problem',
] as const;

export const REPEAT_CHECK_SCHEMA = {
    type: 'object',
    properties: {
        verdicts: {
            type: 'array',
            description: 'One verdict per <Finding>.',
            items: {
                type: 'object',
                properties: {
                    finding: {
                        type: 'number',
                        description: 'The n of the <Finding>.',
                    },
                    verdict: { type: 'string', enum: [...REPEAT_VERDICTS] },
                    earlierId: {
                        type: ['string', 'null'],
                        description:
                            "The id of the <Earlier> comment the verdict is about, one of that finding's own; null for different_problem.",
                    },
                },
                required: ['finding', 'verdict', 'earlierId'],
                additionalProperties: false,
            },
        },
    },
    required: ['verdicts'],
    additionalProperties: false,
} as const;

function kindOf(
    entry: { label?: string; brokenKodyRulesIds?: readonly string[] },
    ruleTitleByUuid?: ReadonlyMap<string, string>,
): string {
    if (!isRule(entry)) return `general review (${entry.label || 'unknown'})`;
    const titles = (entry.brokenKodyRulesIds ?? []).map(
        (id) => ruleTitleByUuid?.get(id) ?? id,
    );
    return titles.length
        ? `Kody Rule ${titles.map((t) => `"${t}"`).join(', ')}`
        : 'Kody Rule';
}

function locationOf(entry: {
    relevantFile?: string;
    relevantLinesStart?: number;
    relevantLinesEnd?: number;
}): string {
    if (!entry.relevantFile) return 'the pull request as a whole';
    if (entry.relevantLinesStart == null) return entry.relevantFile;
    return `${entry.relevantFile}:${entry.relevantLinesStart}-${entry.relevantLinesEnd ?? entry.relevantLinesStart}`;
}

export function buildRepeatCheckPrompt(
    items: Array<{
        finding: RepeatCheckFinding;
        candidates: PrDecisionRecord[];
    }>,
    ruleTitleByUuid?: ReadonlyMap<string, string>,
): string {
    const blocks = items.map(({ finding, candidates }, n) => {
        const earlier = candidates.map((entry) =>
            [
                `  <Earlier id="${entry.suggestionId}">`,
                `  Where: ${locationOf(entry)}`,
                `  Kind: ${kindOf(entry, ruleTitleByUuid)}`,
                `  Comment: ${clip(entry.suggestionContent || '', MAX_TEXT)}`,
                entry.existingCode
                    ? `  Code it pointed at:\n${clip(entry.existingCode, MAX_CODE)}`
                    : '',
                `  </Earlier>`,
            ]
                .filter(Boolean)
                .join('\n'),
        );
        return [
            `<Finding n="${n}">`,
            `Where: ${locationOf(finding)}`,
            `Kind: ${kindOf(finding, ruleTitleByUuid)}`,
            `Finding: ${clip(finding.oneSentenceSummary || finding.suggestionContent || '', MAX_TEXT)}`,
            finding.existingCode
                ? `Code it points at:\n${clip(finding.existingCode, MAX_CODE)}`
                : '',
            ...earlier,
            `</Finding>`,
        ]
            .filter(Boolean)
            .join('\n');
    });

    return `A code review produced new findings on a pull request. Kody already posted comments on this pull request in earlier review rounds. For each finding you get the earlier comments that could be about the same thing.

Give every finding one verdict:
- same_occurrence: it raises the problem an earlier comment raised, in the same piece of code. Also when that code was edited, reformatted or moved to another file, when the finding words it differently or proposes another fix, and when the developer tried to fix it and the problem is still there. Give that comment's id.
- new_place: the same kind of problem, or the same rule, in a different piece of code: another function, call, component or message, or another file where the earlier code is still in place. Give the comment's id.
- caused_by_earlier: a new problem that exists because the change an earlier comment asked for was made, or a finding that asks to undo that change. Give the comment's id.
- different_problem: anything else. earlierId is null.

Compare the code each one points at. A finding about different code is never the same occurrence, however alike the words.
For PR-level comments, compare the behavior, resource or change each comment asks about. A shared rule is not enough; the comments must raise the same problem about the same subject.

${blocks.join('\n\n')}`;
}

function parseVerdicts(
    output: unknown,
    batch: Array<{ finding: unknown; candidates: PrDecisionRecord[] }>,
): {
    repeats: Map<number, PrDecisionRecord>;
    revisions: Map<number, PrDecisionRecord>;
    decided: Set<number>;
} {
    const repeats = new Map<number, PrDecisionRecord>();
    const revisions = new Map<number, PrDecisionRecord>();
    const decided = new Set<number>();
    // A non-strict model may wrap, stringify or bare-array the answer (#1786).
    const verdicts = (
        normalizeEnvelope(output, 'verdicts', ['results', 'findings'], {
            liftEmptyArray: true,
        }) as { verdicts?: unknown }
    )?.verdicts;
    if (!Array.isArray(verdicts)) return { repeats, revisions, decided };
    for (const entry of verdicts) {
        const e = entry as {
            finding?: unknown;
            verdict?: unknown;
            earlierId?: unknown;
        };
        if (
            typeof e?.finding !== 'number' &&
            (typeof e?.finding !== 'string' || !/^\d+$/.test(e.finding))
        )
            continue;
        const n = Number(e.finding);
        if (!Number.isInteger(n) || n < 0 || n >= batch.length) continue;
        if (e.verdict === 'different_problem' || e.verdict === 'new_place') {
            decided.add(n);
            continue;
        }
        // Only an id offered for THAT finding counts.
        const id = String(e.earlierId ?? '');
        const earlier = batch[n].candidates.find((c) => c.suggestionId === id);
        if (!earlier) continue;
        if (e.verdict === 'same_occurrence') {
            decided.add(n);
            if (!repeats.has(n)) repeats.set(n, earlier);
            revisions.delete(n);
        } else if (e.verdict === 'caused_by_earlier') {
            decided.add(n);
            if (!repeats.has(n) && !revisions.has(n)) revisions.set(n, earlier);
        }
    }
    return { repeats, revisions, decided };
}

/** Without a verdict, hold only a likely repost. The same rule in a different
 * place, or a different problem on the same file, still gets a comment. */
function plausibleRepeat(
    finding: RepeatCheckFinding,
    earlier: PrDecisionRecord,
): boolean {
    if (isRule(finding) !== isRule(earlier)) return false;
    const file = normalizePath(finding.relevantFile);
    if (file !== normalizePath(earlier.relevantFile)) return false;
    const similarity = contentSimilarity(finding, earlier);
    if (!file) {
        return (
            isRule(finding) && sharesRule(finding, earlier) && similarity >= 0.3
        );
    }
    const start = finding.relevantLinesStart;
    const oldStart = earlier.relevantLinesStart;
    return (
        start != null &&
        oldStart != null &&
        start <= (earlier.relevantLinesEnd ?? oldStart) &&
        oldStart <= (finding.relevantLinesEnd ?? start) &&
        similarity >= 0.4
    );
}

/**
 * Splits `findings` into what to post and what an earlier comment already
 * raised. Retries unresolved comparisons once in smaller batches. If still
 * undecided, a plausible repeat is withheld and tracked separately.
 */
export async function checkRepeats<T extends RepeatCheckFinding>(
    findings: T[],
    history: readonly PrDecisionRecord[] | undefined,
    options: RepeatCheckOptions,
): Promise<RepeatCheckResult<T>> {
    const result: RepeatCheckResult<T> = {
        kept: [],
        repeats: [],
        withheld: [],
        revisions: [],
        model: 'not-needed',
    };
    if (!history?.length || !findings.length) {
        result.kept = [...findings];
        return result;
    }

    // The by-code match reads the whole history, not the capped candidates;
    // the most recent entry wins a key.
    const byOccurrence = new Map<string, PrDecisionRecord>();
    for (const earlier of history) {
        for (const key of occurrenceKeys(earlier)) {
            if (!byOccurrence.has(key)) byOccurrence.set(key, earlier);
        }
    }

    const matchOf = new Map<T, RepeatOf<T>>();
    const revisionOf = new Map<T, PrDecisionRecord>();
    const toJudge: Array<{ finding: T; candidates: PrDecisionRecord[] }> = [];
    for (const finding of findings) {
        const candidates = repeatCandidates(finding, history);
        // Only a rule finding is matched by code.
        const byCode = isRule(finding)
            ? occurrenceKeys(finding)
                  .map((key) => byOccurrence.get(key))
                  .find(Boolean)
            : undefined;
        if (byCode) {
            matchOf.set(finding, { finding, earlier: byCode, by: 'code' });
        } else if (candidates.length) {
            toJudge.push({ finding, candidates });
        }
    }

    const unresolved = new Set(toJudge);
    if (toJudge.length) {
        if (!options.byokConfig && !hasManagedModelKey()) {
            result.model = 'no-model';
        } else {
            const judgeBatch = async (
                batch: typeof toJudge,
                timeoutMs: number,
            ) => {
                try {
                    const output = await LLM.run({
                        byokConfig: options.byokConfig,
                        schema: jsonSchema(REPEAT_CHECK_SCHEMA as any),
                        user: buildRepeatCheckPrompt(
                            batch,
                            options.ruleTitleByUuid,
                        ),
                        runName: 'code-review-repeat-check',
                        spanName: 'code-review::repeat-check',
                        timeoutMs,
                        organizationId: options.organizationId,
                        telemetryMetadata: options.telemetryMetadata,
                        attrs: {
                            type: options.byokConfig ? 'byok' : 'system',
                            retry: timeoutMs === RETRY_TIMEOUT_MS,
                            ...(options.prNumber != null
                                ? { prNumber: options.prNumber }
                                : {}),
                        },
                    });
                    const verdicts = parseVerdicts(output, batch);
                    for (const [n, earlier] of verdicts.repeats) {
                        const { finding } = batch[n];
                        matchOf.set(finding, { finding, earlier, by: 'model' });
                    }
                    for (const [n, earlier] of verdicts.revisions) {
                        revisionOf.set(batch[n].finding, earlier);
                    }
                    for (const n of verdicts.decided)
                        unresolved.delete(batch[n]);
                } catch (error) {
                    logger.warn({
                        message: `[REPEAT-CHECK] PR#${options.prNumber}: no verdict for ${batch.length} finding(s)`,
                        context: 'RepeatCheck',
                        error,
                        metadata: {
                            organizationId: options.organizationId,
                            prNumber: options.prNumber,
                            batchSize: batch.length,
                            timeoutMs,
                        },
                    });
                }
            };
            const judge = async (
                entries: typeof toJudge,
                size: number,
                timeoutMs: number,
            ) => {
                const jobs: Promise<void>[] = [];
                for (let i = 0; i < entries.length; i += size) {
                    jobs.push(
                        judgeBatch(entries.slice(i, i + size), timeoutMs),
                    );
                }
                await Promise.all(jobs);
            };
            await judge(toJudge, BATCH_SIZE, REPEAT_CHECK_TIMEOUT_MS);
            await judge([...unresolved], RETRY_BATCH_SIZE, RETRY_TIMEOUT_MS);
            result.model = unresolved.size ? 'failed' : 'ok';
        }
    }

    const withheld = new Set(
        (result.model === 'failed' ? [...unresolved] : [])
            .filter(({ finding, candidates }) =>
                candidates.some((earlier) => plausibleRepeat(finding, earlier)),
            )
            .map(({ finding }) => finding),
    );
    for (const finding of findings) {
        const match = matchOf.get(finding);
        if (match) result.repeats.push(match);
        else if (withheld.has(finding)) result.withheld.push(finding);
        else {
            result.kept.push(finding);
            const earlier = revisionOf.get(finding);
            if (earlier) result.revisions.push({ finding, earlier });
        }
    }
    return result;
}
