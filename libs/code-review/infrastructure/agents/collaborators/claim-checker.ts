/**
 * Deterministic claim checker for kody-rules findings (issue #1826).
 *
 * Between the model's word and the published comment, the Kody Rules path has
 * never performed a single check of a finding's merit — the `verify` gate lives
 * in the agentic finder, which this path bypasses. So a shard that sees one
 * file's hunks can assert "this import is unused" about a symbol used twenty
 * lines below the window and the assertion ships (#1724).
 *
 * This module refutes the assertion instead of trusting it. A finding that
 * declares a `claimKind` gets exactly one cheap, deterministic repository check
 * (grep or path existence, never a model call); when the repository contradicts
 * the claim, the finding is dropped. That is the RepoAudit validator pattern at
 * the opposite polarity: a symbolic check adjudicating an LLM alert.
 *
 * Two properties are load-bearing:
 *
 *   1. FAIL CLOSED. "I could not check" is never "I checked and it holds". An
 *      unavailable lookup, a timeout, or a transport error all drop the
 *      finding. Publishing an unverifiable claim is the bug; losing a comment
 *      is the acceptable cost.
 *   2. NO CLAIM, NO CHECK. `none` — which is also where every malformed or
 *      untargeted claim lands — is published unchanged, exactly as today. The
 *      checker is deliberately narrow: it only adjudicates what it can refute.
 *
 * Pure orchestration over an injected `RepoLookup`, so it is unit-testable
 * without a sandbox.
 */
import type { LogArguments } from '@libs/core/log/logger';
import { GREP_NO_MATCHES } from './repo-lookup';
import type { RepoLookup } from './repo-lookup';
import { SHARD_CONCURRENCY_DEFAULT } from './kody-rules-sharded.judge';
import type { ShardViolation } from './kody-rules-sharded.judge';

export type ClaimKind = 'unused' | 'missing' | 'duplicate' | 'none';

export interface Claim {
    kind: ClaimKind;
    symbol?: string;
    path?: string;
}

/**
 * Structurally what `createLogger()` hands back, so the real `SimpleLogger` is
 * assignable without a cast. The hand-rolled shape this replaced declared
 * `context` optional while `LogArguments` requires it, which made every
 * production call site a type error.
 */
export interface ClaimCheckLogger {
    warn: (entry: LogArguments) => void;
}

export interface ClaimCheckInput {
    violations: ShardViolation[];
    /** The PR's changed files — a `missing` path this PR adds is not missing. */
    changedFiles: Array<{ filename: string }>;
    lookup: RepoLookup;
    /** Bounded to the shard concurrency limit by the caller (KRC-07). */
    concurrency?: number;
    /** Per-check budget; exceeding it means unverifiable, never confirmed. */
    timeoutMs?: number;
    logger?: ClaimCheckLogger;
    /** For the drop-warning's metadata, so a discard is traceable per organization. */
    organizationId?: string;
}

export interface DroppedClaim {
    violation: ShardViolation;
    reason: string;
}

export interface ClaimCheckResult {
    kept: ShardViolation[];
    dropped: DroppedClaim[];
}

/**
 * Per-check time budget. Neither spec nor design fixes a number, so this is the
 * conservative one: a repository grep that has not answered in five seconds is
 * not going to change the verdict, and waiting longer only delays the review.
 */
const DEFAULT_TIMEOUT_MS = 5_000;

/** What `RemoteCommands.grep` returns when ripgrep matched nothing. */
const NO_MATCHES = GREP_NO_MATCHES;

const normalizePath = (p: string): string => p.replace(/^\.\//, '').trim();

/**
 * Whether a claimed path names a file rather than a directory.
 *
 * `exists` answers over a listing of FILES, so a directory always comes back
 * false. A comment that says "reuse the helper in src/shared" names a real
 * place, and dropping it for that would be the checker inventing a defect.
 * Only the last segment having a dot is treated as a file.
 */
const looksLikeFile = (p: string): boolean =>
    /\.[^./]+$/.test(p.split('/').pop() ?? '');

/** ripgrep is a regex engine; a claimed symbol is a literal. */
const escapeRegex = (s: string): string =>
    s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class UnverifiableClaimError extends Error {}

/**
 * The claim a violation actually carries, after the degradations KRC-09 and
 * KRC-21 require. A kind we do not know, or a kind whose target is absent,
 * names nothing checkable — so it is `none` and the finding is published
 * unchanged rather than dropped for being unparseable.
 */
export function readClaim(violation: ShardViolation): Claim {
    const symbol = violation.claimSymbol?.trim() || undefined;
    const path = violation.claimPath?.trim() || undefined;
    const kind = violation.claimKind;

    if (kind === 'unused' || kind === 'duplicate') {
        return symbol ? { kind, symbol, path } : { kind: 'none' };
    }
    if (kind === 'missing') {
        return path ? { kind, symbol, path } : { kind: 'none' };
    }
    return { kind: 'none' };
}

interface GrepMatch {
    file: string;
    line: number;
}

/**
 * Parse `rg --no-heading -n` output (`path:line:content`). A transport failure
 * comes back as an `Error: …` string rather than a throw, and reading that as
 * "no matches" would confirm an `unused` claim with a broken grep — the exact
 * silence this feature exists to remove — so it raises instead.
 */
function parseGrep(output: string): GrepMatch[] {
    const text = output?.trim() ?? '';
    if (!text || text === NO_MATCHES) return [];
    if (text.startsWith('Error:')) {
        throw new UnverifiableClaimError(text);
    }
    const matches: GrepMatch[] = [];
    for (const raw of text.split('\n')) {
        const m = /^(.+?):(\d+):/.exec(raw.trim());
        if (m) matches.push({ file: normalizePath(m[1]), line: Number(m[2]) });
    }
    return matches;
}

/**
 * Whether a grep hit lies outside the finding's own lines. A finding that says
 * a symbol is unused necessarily contains that symbol itself; only an
 * occurrence somewhere ELSE refutes it (and, symmetrically, only an occurrence
 * somewhere else can support a `duplicate` claim).
 */
function isElsewhere(match: GrepMatch, violation: ShardViolation): boolean {
    if (
        !violation.relevantFile ||
        normalizePath(violation.relevantFile) !== match.file
    ) {
        return true;
    }
    const start = violation.relevantLinesStart;
    const end = violation.relevantLinesEnd ?? start;
    if (start === undefined || end === undefined) return true;
    return match.line < start || match.line > end;
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new UnverifiableClaimError(
                                `the repository check exceeded its ${timeoutMs}ms budget`,
                            ),
                        ),
                    timeoutMs,
                );
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Run one claim's check. Resolves to a drop reason, or null to keep.
 * Every failure mode raises `UnverifiableClaimError`, which the caller turns
 * into a drop — never into a confirmation.
 */
async function refute(
    claim: Claim,
    violation: ShardViolation,
    input: ClaimCheckInput,
): Promise<string | null> {
    const { lookup, changedFiles } = input;

    if (claim.kind === 'missing') {
        const wanted = normalizePath(claim.path!);
        const addedByThisPr = changedFiles.some(
            (f) => normalizePath(f.filename) === wanted,
        );
        if (addedByThisPr) {
            return `claimed "${wanted}" is missing, but this PR changes it`;
        }
        if (await lookup.exists(claim.path!)) {
            return `claimed "${wanted}" is missing, but it exists in the repository`;
        }
        return null;
    }

    // A non-`missing` claim may ALSO name a path, as supporting evidence:
    // "reuse the helper already in src/shared/slugify.ts". The wire schema asks
    // for `claimPath` on every claim and models fill it in, but only the
    // `missing` branch above ever looked at it — so a fabricated path shipped
    // as long as the SYMBOL was real. Observed: a finding that correctly said
    // `slugify` is duplicated, and sent the developer to a file that does not
    // exist.
    //
    // Only a path that looks like a FILE is checked. "src/shared" is a
    // directory and a perfectly good thing for a comment to name; `exists`
    // lists files, so judging it here would drop true findings.
    if (claim.path && looksLikeFile(claim.path)) {
        const named = normalizePath(claim.path);
        const inThisPr = changedFiles.some(
            (f) => normalizePath(f.filename) === named,
        );
        if (!inThisPr && !(await lookup.exists(claim.path))) {
            return `pointed at "${named}", which does not exist in the repository`;
        }
    }

    const matches = parseGrep(await lookup.grep(escapeRegex(claim.symbol!)));
    const elsewhere = matches.filter((m) => isElsewhere(m, violation));

    if (claim.kind === 'unused') {
        if (elsewhere.length === 0) return null;
        const where = elsewhere
            .slice(0, 3)
            .map((m) => `${m.file}:${m.line}`)
            .join(', ');
        return `claimed "${claim.symbol}" is unused, but it is used at ${where}`;
    }

    // SPEC_DEVIATION: design.md's check table says a `duplicate` claim drops
    // when there is "no match anywhere". It drops here when there is no match
    // OUTSIDE the finding's own lines.
    // Reason: the flagged code contains the symbol itself, so "anywhere" would
    // let a finding's own line stand in as the pre-existing helper it claims to
    // duplicate — confirming the claim with the claim. `elsewhere` is the same
    // notion `unused` already uses, at the opposite polarity.
    if (elsewhere.length === 0) {
        return `claimed "${claim.symbol}" already exists, but it exists nowhere else in the repository`;
    }
    return null;
}

/**
 * The unit a claim is adjudicated in: one rule, one file, one assertion.
 *
 * The shard prompt asks for "one entry PER violating line PER rule; do not
 * collapse repeats", and the pipeline's `dedupKodyRulesByRuleUuid` folds those
 * repeats back into a SINGLE published comment. Whether a given RUN expands or
 * collapses is sampling variance, not a model trait: kimi-k2.7-code returned
 * one ranged finding in seven observed runs of the same case and eight
 * per-line findings in the eighth.
 *
 * Checking per finding while publishing per group let a refutation land on one
 * sibling while the same assertion shipped on another - in that eighth run the
 * claim was declared on one finding, refuted, and the seven undeclared
 * siblings survived to publish it anyway. Grouping makes the checked unit the
 * published unit, which is the only version of this check that holds whatever
 * model the customer brings and whatever shape a given run returns.
 *
 * The key is (rule, file) and NOTHING ELSE. An earlier version added the
 * finding's own text as a third component, reasoning that one rule may report
 * two different things in one file and a refutation of the first should not
 * silence the second. That reasoning does not survive contact with
 * `dedupKodyRulesByRuleUuid`, which folds every finding sharing a ruleUuid -
 * across files, whatever the wording - into ONE published comment. The
 * distinction the text was protecting is erased before the customer sees it,
 * so the only thing it bought was a split: the model phrases per line, eight
 * findings landed in eight groups, the one declared claim was refuted alone
 * and the seven undeclared siblings published the refuted assertion anyway.
 * Measured on a real E2B run: 1 of 20 negative case-runs leaked exactly that
 * way. The unit stays no finer than what publishing can tell apart.
 */
const groupKeyOf = (violation: ShardViolation): string =>
    [
        violation.ruleUuid ?? '',
        normalizePath(violation.relevantFile ?? ''),
    ].join('::');

/**
 * Does this finding restate the assertion that was refuted?
 *
 * The refuted claim names a target - a symbol, a path, or both. A sibling that
 * is republishing that assertion necessarily names the same target, because
 * that is what the assertion is ABOUT; a sibling about something else in the
 * same file does not. Matching on the target rather than on the sentence is
 * what makes this hold for a model that rewords per line and for a review
 * localized into any language: an identifier and a path survive translation,
 * a sentence does not.
 *
 * Deliberately permissive on the path (the basename counts) and strict on the
 * symbol (delimited, so `slug` does not match `slugify`). When the claim named
 * no target at all there is nothing to match on, and the sibling is kept.
 */
function restates(violation: ShardViolation, claim: Claim): boolean {
    const text = `${violation.oneSentenceSummary ?? ''} ${violation.suggestionContent ?? ''} ${violation.existingCode ?? ''}`;
    if (!text.trim()) return false;

    if (claim.symbol) {
        const escaped = claim.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`).test(text)) {
            return true;
        }
    }
    if (claim.path) {
        const normalized = normalizePath(claim.path);
        const base = normalized.split('/').filter(Boolean).pop() ?? '';
        if (normalized && text.includes(normalized)) return true;
        if (base && text.includes(base)) return true;
    }
    return false;
}

/** Identity of a claim, so one repository check serves every finding making it. */
const claimKeyOf = (claim: Claim): string =>
    `${claim.kind}::${claim.symbol ?? ''}::${claim.path ?? ''}`;

/**
 * The group's own lines, as one span. `refute` excludes a finding's own lines
 * when deciding whether a symbol occurs "elsewhere"; with siblings, the whole
 * group is the finding, so the span is their union. For a lone finding this is
 * its own range and the behaviour is byte-identical to before.
 */
function spanOf(group: ShardViolation[]): ShardViolation {
    const starts = group
        .map((v) => v.relevantLinesStart)
        .filter((n): n is number => typeof n === 'number');
    const ends = group
        .map((v) => v.relevantLinesEnd ?? v.relevantLinesStart)
        .filter((n): n is number => typeof n === 'number');
    return {
        ...group[0],
        relevantLinesStart: starts.length ? Math.min(...starts) : undefined,
        relevantLinesEnd: ends.length ? Math.max(...ends) : undefined,
    };
}

/**
 * Check every violation's claim against the repository and split the batch into
 * what may be published and what the repository refuted (or left unverifiable).
 *
 * Findings are adjudicated in (rule, file, assertion) groups. A finding that declares its
 * own claim is judged by that claim's verdict; a finding that declares nothing
 * inherits a refutation from any sibling, because the group ships as one
 * comment and an undeclared sibling would otherwise carry an assertion the
 * repository already refuted. A group where nobody declares anything is still
 * not checked at all - "no claim, no check" is unchanged.
 */
export async function checkClaims(
    input: ClaimCheckInput,
): Promise<ClaimCheckResult> {
    const { violations, lookup, logger, organizationId } = input;
    const concurrency = input.concurrency ?? SHARD_CONCURRENCY_DEFAULT;
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const groups = new Map<string, ShardViolation[]>();
    for (const violation of violations) {
        const key = groupKeyOf(violation);
        const group = groups.get(key);
        if (group) {
            group.push(violation);
        } else {
            groups.set(key, [violation]);
        }
    }

    // One repository check per DISTINCT claim per group, not per finding: eight
    // findings making one assertion cost one grep, not eight.
    const jobs: Array<{
        groupKey: string;
        claimKey: string;
        claim: Claim;
        span: ShardViolation;
    }> = [];
    for (const [groupKey, group] of groups) {
        const span = spanOf(group);
        const seen = new Set<string>();
        for (const violation of group) {
            const claim = readClaim(violation);
            if (claim.kind === 'none') {
                continue;
            }
            const claimKey = claimKeyOf(claim);
            if (seen.has(claimKey)) {
                continue;
            }
            seen.add(claimKey);
            jobs.push({ groupKey, claimKey, claim, span });
        }
    }

    const verdicts = await mapLimit(
        jobs,
        concurrency,
        async ({ claim, span }): Promise<string | null> => {
            if (!lookup.available) {
                return `unverifiable: repository lookup unavailable (${lookup.unavailableReason})`;
            }

            try {
                return await withTimeout(refute(claim, span, input), timeoutMs);
            } catch (err) {
                // Includes RepoLookupUnavailableError: the lookup can go
                // unavailable mid-review (its own probe disables it), and the
                // throw must stop this finding, not the whole shard's result.
                const detail = err instanceof Error ? err.message : String(err);
                logger?.warn({
                    message: `[claim-checker] could not verify a ${claim.kind} claim — dropping the finding: ${detail}`,
                    context: 'claim-checker',
                    metadata: {
                        ruleUuid: span.ruleUuid,
                        filename: span.relevantFile,
                        claimKind: claim.kind,
                        organizationId,
                    },
                });
                return `unverifiable: ${detail}`;
            }
        },
    );

    /** Drop reason per claim, and the first refuted claim seen in each group. */
    const byClaim = new Map<string, string>();
    const byGroup = new Map<string, { reason: string; claim: Claim }>();
    jobs.forEach((job, i) => {
        const reason = verdicts[i];
        if (!reason) {
            return;
        }
        byClaim.set(`${job.groupKey}::${job.claimKey}`, reason);
        if (!byGroup.has(job.groupKey)) {
            byGroup.set(job.groupKey, { reason, claim: job.claim });
        }
    });

    const kept: ShardViolation[] = [];
    const dropped: DroppedClaim[] = [];
    for (const violation of violations) {
        const groupKey = groupKeyOf(violation);
        const claim = readClaim(violation);
        let reason: string | undefined;
        if (claim.kind === 'none') {
            // A finding that asserts nothing is dropped only when it is
            // RESTATING a sibling's refuted assertion. Two findings of one rule
            // in one file may be about genuinely different things, and killing
            // the second because the first was wrong would trade a false
            // positive for a false negative.
            //
            // What separates the two is not prose - the model rewords per line,
            // and a customer's output may not even be in English - but whether
            // the finding names the thing the refutation was about. That target
            // is an identifier or a path: code, not language.
            const refuted = byGroup.get(groupKey);
            if (refuted && restates(violation, refuted.claim)) {
                reason = refuted.reason;
            }
        } else {
            reason = byClaim.get(`${groupKey}::${claimKeyOf(claim)}`);
        }
        if (reason) {
            dropped.push({ violation, reason });
        } else {
            kept.push(violation);
        }
    }
    return { kept, dropped };
}

/**
 * Same bounded-concurrency walk the sharded judge uses (kept local: importing
 * a value from the judge would close a require cycle, since the judge's own
 * types are imported above).
 */
async function mapLimit<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const out = new Array<R>(items.length);
    let i = 0;
    await Promise.all(
        Array.from(
            { length: Math.min(Math.max(1, limit), items.length || 1) },
            async () => {
                while (i < items.length) {
                    const idx = i++;
                    out[idx] = await fn(items[idx]);
                }
            },
        ),
    );
    return out;
}
