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
import type { RepoLookup } from './repo-lookup';
import type { ShardViolation } from './kody-rules-sharded.judge';

export type ClaimKind = 'unused' | 'missing' | 'duplicate' | 'none';

export interface Claim {
    kind: ClaimKind;
    symbol?: string;
    path?: string;
}

export interface ClaimCheckLogger {
    warn: (entry: {
        message: string;
        context?: string;
        metadata?: Record<string, unknown>;
    }) => void;
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
}

export interface DroppedClaim {
    violation: ShardViolation;
    reason: string;
}

export interface ClaimCheckResult {
    kept: ShardViolation[];
    dropped: DroppedClaim[];
}

/** Same default the sharded judge uses, so checks never outpace the shards. */
const DEFAULT_CONCURRENCY = 4;

/**
 * Per-check time budget. Neither spec nor design fixes a number, so this is the
 * conservative one: a repository grep that has not answered in five seconds is
 * not going to change the verdict, and waiting longer only delays the review.
 */
const DEFAULT_TIMEOUT_MS = 5_000;

/** What `RemoteCommands.grep` returns when ripgrep matched nothing. */
const NO_MATCHES = 'No matches found.';

const normalizePath = (p: string): string => p.replace(/^\.\//, '').trim();

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

async function withTimeout<T>(
    work: Promise<T>,
    timeoutMs: number,
): Promise<T> {
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
 * Check every violation's claim against the repository and split the batch into
 * what may be published and what the repository refuted (or left unverifiable).
 */
export async function checkClaims(
    input: ClaimCheckInput,
): Promise<ClaimCheckResult> {
    const { violations, lookup, logger } = input;
    const concurrency = input.concurrency ?? DEFAULT_CONCURRENCY;
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const verdicts = await mapLimit(
        violations,
        concurrency,
        async (violation): Promise<string | null> => {
            const claim = readClaim(violation);
            if (claim.kind === 'none') return null;

            if (!lookup.available) {
                return `unverifiable: repository lookup unavailable (${lookup.unavailableReason})`;
            }

            try {
                return await withTimeout(
                    refute(claim, violation, input),
                    timeoutMs,
                );
            } catch (err) {
                // Includes RepoLookupUnavailableError: the lookup can go
                // unavailable mid-review (its own probe disables it), and the
                // throw must stop this finding, not the whole shard's result.
                const detail =
                    err instanceof Error ? err.message : String(err);
                logger?.warn({
                    message: `[claim-checker] could not verify a ${claim.kind} claim — dropping the finding: ${detail}`,
                    context: 'claim-checker',
                    metadata: {
                        ruleUuid: violation.ruleUuid,
                        filename: violation.relevantFile,
                        claimKind: claim.kind,
                    },
                });
                return `unverifiable: ${detail}`;
            }
        },
    );

    const kept: ShardViolation[] = [];
    const dropped: DroppedClaim[] = [];
    violations.forEach((violation, i) => {
        const reason = verdicts[i];
        if (reason) dropped.push({ violation, reason });
        else kept.push(violation);
    });
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
