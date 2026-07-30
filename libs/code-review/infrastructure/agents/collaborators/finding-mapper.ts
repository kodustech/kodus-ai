/**
 * code-review (domain) — maps raw agent findings to CodeSuggestion shape.
 *
 * Phase 2 of the provider decomposition. Pulls the "what the agent emitted →
 * what the pipeline consumes" translation out of BaseCodeReviewAgentProvider:
 * path validation/canonicalization, kody-rules UUID recovery, label/severity
 * resolution. No NestJS, no LLM — a logger is injected so it stays unit-testable.
 */
import {
    CodeSuggestion,
    FileChange,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import {
    IKodyRule,
    resolveKodyRuleSeverityLevel,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import { normalizeRepoPath } from '@libs/code-review/infrastructure/agents/engine/coverage-ledger';

// ── Bounded Levenshtein + UUID recovery ──────────────────────────────────────

// Bounded Levenshtein distance — returns early once it exceeds `max`.
// Used to recover a kody_rules ruleUuid the LLM corrupted while echoing
// it (LLMs occasionally drop/transpose a character in a 36-char UUID).
function boundedEditDistance(a: string, b: string, max: number): number {
    if (Math.abs(a.length - b.length) > max) {
        return max + 1;
    }
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);

    for (let i = 1; i <= a.length; i++) {
        const curr = [i];
        let rowMin = i;

        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            const v = Math.min(
                prev[j] + 1,
                curr[j - 1] + 1,
                prev[j - 1] + cost,
            );
            curr.push(v);
            if (v < rowMin) {
                rowMin = v;
            }
        }
        if (rowMin > max) {
            return max + 1;
        } // whole row already over budget
        prev = curr;
    }
    return prev[b.length];
}

// Recover the intended rule when the LLM-emitted `ruleUuid` is not an
// exact key but is within a tiny edit distance of EXACTLY ONE known rule.
// UUIDs don't collide within distance 2, and the per-PR rule set is small,
// so a unique near-match is an unambiguous recovery; ambiguity (0 or >1
// matches) returns null so the caller drops the suggestion. See #1170.
export function recoverRuleUuid(
    emitted: string,
    knownUuids: Iterable<string>,
): string | null {
    const MAX_DISTANCE = 2;
    let match: string | null = null;
    for (const known of knownUuids) {
        if (boundedEditDistance(emitted, known, MAX_DISTANCE) <= MAX_DISTANCE) {
            if (match) {
                return null;
            } // more than one near-match → ambiguous
            match = known;
        }
    }
    return match;
}

// ── Label resolution ─────────────────────────────────────────────────────────

export interface LabelPolicy {
    /** The agent's fixed category (bug/security/performance/kody_rules/generalist). */
    categoryLabel: string;
    /** Labels this run may emit (for mixed/generalist reviewers). */
    allowedLabels: Array<'bug' | 'security' | 'performance'>;
    /** Whether the agent emits per-finding labels (generalist) vs a fixed one. */
    supportsMixed: boolean;
}

/** Resolve the final label of a suggestion under the agent's label policy.
 *  Single-category agents always return their category; mixed reviewers honor
 *  the LLM-emitted label when it's allowed, else fall back to the first allowed. */
export function resolveSuggestionLabel(
    suggestion: { label?: string },
    policy: LabelPolicy,
): string {
    if (!policy.supportsMixed) {
        return policy.categoryLabel;
    }
    const allowed = new Set(policy.allowedLabels);
    const rawLabel =
        typeof suggestion.label === 'string'
            ? suggestion.label.toLowerCase()
            : '';
    if (
        (rawLabel === 'bug' ||
            rawLabel === 'security' ||
            rawLabel === 'performance') &&
        allowed.has(rawLabel as 'bug' | 'security' | 'performance')
    ) {
        return rawLabel;
    }
    return policy.allowedLabels[0] || 'bug';
}

// ── Finding mapping ──────────────────────────────────────────────────────────

/** Loose shape of a raw finding emitted by the agent loop. */
export interface RawFinding {
    suggestionContent?: string;
    ruleUuid?: string;
    relevantFile?: string;
    oneSentenceSummary?: string;
    language?: string;
    existingCode?: string;
    improvedCode?: string;
    relevantLinesStart?: number;
    relevantLinesEnd?: number;
    severity?: string;
    label?: string;
}

export interface MappableAgentResult {
    findings?: { suggestions?: RawFinding[] };
    discardedBySeverity?: RawFinding[];
    droppedByVerify?: RawFinding[];
}

export interface FindingMapperContext {
    changedFiles: FileChange[];
    kodyRules?: Partial<IKodyRule>[];
    prNumber: number;
    isKodyRules: boolean;
    /** Name used in warning logs (the agent identity). */
    identityName: string;
    labelPolicy: LabelPolicy;
    /** Injected so the mapper stays free of NestJS; optional for tests.
     *  Typed loosely to accept the app's SimpleLogger.warn shape. */
    logger?: { warn: (entry: any) => void };
}

export interface MappedFindings {
    suggestions: Partial<CodeSuggestion>[];
    discardedBySeverity: Partial<CodeSuggestion>[];
    discardedByVerify: Partial<CodeSuggestion>[];
}

/**
 * Translate raw agent findings into pipeline `CodeSuggestion`s:
 *  - drop suggestions whose `relevantFile` isn't in the PR (post-normalization)
 *  - kody-rules: require a known `ruleUuid` (with edit-distance recovery)
 *  - canonicalize the path back to the provider's original filename
 *  - resolve label + severity (kody-rule severity overrides the LLM's)
 */
export function mapAgentFindings(
    agentResult: MappableAgentResult,
    ctx: FindingMapperContext,
): MappedFindings {
    // Key on the normalized path so we tolerate LLM-emitted variations
    // (missing leading slash, backslashes), but keep the provider's original
    // filename as the value (downstream comment posting needs the exact shape).
    const validFilesByNormalized = new Map<string, string>(
        ctx.changedFiles.map((f) => [
            normalizeRepoPath(f.filename),
            f.filename,
        ]),
    );
    const kodyRulesByUuid = new Map(
        (ctx.kodyRules || []).filter((r) => r.uuid).map((r) => [r.uuid!, r]),
    );
    const warn = (message: string, metadata: Record<string, unknown>) =>
        ctx.logger?.warn({ message, context: ctx.identityName, metadata });

    const rawSuggestions = (agentResult.findings?.suggestions || []).filter(
        (s) => {
            if (!s.suggestionContent) {
                return false;
            }

            if (ctx.isKodyRules) {
                const ruleUuid =
                    typeof s.ruleUuid === 'string' ? s.ruleUuid.trim() : '';

                if (!ruleUuid) {
                    // Model omitted the uuid echo. With exactly ONE candidate
                    // rule in play there is no ambiguity — attribute instead
                    // of dropping (observed live: both violations of the only
                    // selected rule were found and then discarded here, so
                    // the customer saw "rule never fires" even after the
                    // path-matching fix).
                    if (kodyRulesByUuid.size === 1) {
                        const only = [...kodyRulesByUuid.keys()][0];
                        warn(
                            `[AGENT] kody_rules suggestion missing ruleUuid — attributing to the single selected rule ${only}`,
                            { prNumber: ctx.prNumber },
                        );
                        s.ruleUuid = only;
                    } else {
                        warn(
                            `[AGENT] Dropping kody_rules suggestion without ruleUuid (${kodyRulesByUuid.size} candidate rules, ambiguous): "${(s.oneSentenceSummary || s.suggestionContent).slice(0, 140)}"`,
                            { prNumber: ctx.prNumber },
                        );
                        return false;
                    }
                }
                const resolvedRuleUuid =
                    typeof s.ruleUuid === 'string' ? s.ruleUuid.trim() : '';

                if (!kodyRulesByUuid.has(resolvedRuleUuid)) {
                    const recovered = recoverRuleUuid(
                        resolvedRuleUuid,
                        kodyRulesByUuid.keys(),
                    );

                    if (recovered) {
                        warn(
                            `[AGENT] Recovered corrupted kody_rules ruleUuid=${resolvedRuleUuid} → ${recovered} (LLM UUID echo drift)`,
                            { prNumber: ctx.prNumber },
                        );
                        s.ruleUuid = recovered;
                    } else {
                        warn(
                            `[AGENT] Dropping kody_rules suggestion with unknown ruleUuid=${resolvedRuleUuid}: "${(s.oneSentenceSummary || s.suggestionContent).slice(0, 140)}"`,
                            {
                                prNumber: ctx.prNumber,
                                ruleUuid: resolvedRuleUuid,
                                knownRuleCount: kodyRulesByUuid.size,
                            },
                        );
                        return false;
                    }
                }
                // PR-level kody_rules omit relevantFile by design.
                const kodyRulePathMatch =
                    !s.relevantFile ||
                    validFilesByNormalized.has(
                        normalizeRepoPath(s.relevantFile),
                    );

                if (!kodyRulePathMatch) {
                    warn(
                        `@@PATH_MISMATCH@@ Dropping kody_rules suggestion — relevantFile not in changedFiles after normalization`,
                        {
                            prNumber: ctx.prNumber,
                            relevantFile: s.relevantFile,
                            normalizedRelevantFile: normalizeRepoPath(
                                s.relevantFile,
                            ),
                            changedFiles: [...validFilesByNormalized.values()],
                            suggestionPreview: (
                                s.oneSentenceSummary ||
                                s.suggestionContent ||
                                ''
                            ).slice(0, 140),
                        },
                    );
                }
                return kodyRulePathMatch;
            }

            const pathMatch =
                !!s.relevantFile &&
                validFilesByNormalized.has(normalizeRepoPath(s.relevantFile));

            if (!pathMatch && s.relevantFile) {
                warn(
                    `@@PATH_MISMATCH@@ Dropping suggestion — relevantFile not in changedFiles after normalization`,
                    {
                        prNumber: ctx.prNumber,
                        relevantFile: s.relevantFile,
                        normalizedRelevantFile: normalizeRepoPath(
                            s.relevantFile,
                        ),
                        changedFiles: [...validFilesByNormalized.values()],
                        severity: s.severity,
                        suggestionPreview: (
                            s.oneSentenceSummary ||
                            s.suggestionContent ||
                            ''
                        ).slice(0, 140),
                    },
                );
            }
            return pathMatch;
        },
    );

    const suggestions = rawSuggestions.map((s) => {
        const matchedRule = s.ruleUuid
            ? kodyRulesByUuid.get(s.ruleUuid)
            : undefined;

        // Replace the LLM-emitted relevantFile with the provider's original
        // filename so downstream comment posting uses the exact path shape.
        const canonicalRelevantFile = s.relevantFile
            ? (validFilesByNormalized.get(normalizeRepoPath(s.relevantFile)) ??
              s.relevantFile)
            : s.relevantFile;

        return {
            relevantFile: canonicalRelevantFile,
            language: s.language || '',
            suggestionContent: s.suggestionContent,
            existingCode: s.existingCode || '',
            improvedCode: s.improvedCode || '',
            oneSentenceSummary: s.oneSentenceSummary || '',
            relevantLinesStart: s.relevantLinesStart,
            relevantLinesEnd: s.relevantLinesEnd,
            label: resolveSuggestionLabel(s, ctx.labelPolicy),
            severity: matchedRule
                ? resolveKodyRuleSeverityLevel(matchedRule)
                : s.severity || 'medium',
            llmPrompt: s.suggestionContent,
            ...(s.ruleUuid && { brokenKodyRulesIds: [s.ruleUuid] }),
        } as Partial<CodeSuggestion>;
    });

    const mapDiscarded = (list?: RawFinding[]): Partial<CodeSuggestion>[] =>
        (list || []).map((s) => ({
            relevantFile: s.relevantFile,
            suggestionContent: s.suggestionContent,
            severity: (s.severity || 'medium') as CodeSuggestion['severity'],
            label: resolveSuggestionLabel(s, ctx.labelPolicy),
            oneSentenceSummary: s.oneSentenceSummary || '',
        }));

    return {
        suggestions,
        discardedBySeverity: mapDiscarded(agentResult.discardedBySeverity),
        discardedByVerify: mapDiscarded(agentResult.droppedByVerify),
    };
}
