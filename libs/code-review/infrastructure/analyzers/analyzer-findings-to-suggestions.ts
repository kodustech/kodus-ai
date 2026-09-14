import { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';

import { AnalyzerFinding } from './analyzer-finding.type';

/** Where a rule-pack finding says it came from. */
export const RULE_PACK_SOURCE = 'kodus-rule-pack';

const SEVERITY_BY_LEVEL: Record<AnalyzerFinding['severity'], string> = {
    error: 'high',
    warning: 'medium',
    note: 'low',
};

const SEVERITY_RANK: Record<AnalyzerFinding['severity'], number> = {
    error: 3,
    warning: 2,
    note: 1,
};

/**
 * Converts rule-pack findings into review suggestions so they travel the same
 * path as everything else — dedup against the model's findings, severity
 * filtering, comment rendering — rather than arriving as a second, parallel
 * stream of output.
 *
 * Provenance rides along on `evidence`, so a published comment can name the
 * rule that fired instead of implying the model reasoned its way there.
 */
export function analyzerFindingsToSuggestions(
    findings: AnalyzerFinding[],
): Partial<CodeSuggestion>[] {
    // Two rules firing on one line is one problem to a reader. Keep the most
    // severe; ties keep the first seen.
    const strongest = new Map<string, AnalyzerFinding>();
    for (const finding of findings) {
        const key = `${finding.path}:${finding.startLine}`;
        const current = strongest.get(key);
        if (
            !current ||
            SEVERITY_RANK[finding.severity] > SEVERITY_RANK[current.severity]
        ) {
            strongest.set(key, finding);
        }
    }

    return [...strongest.values()].map((finding) => ({
        relevantFile: finding.path,
        relevantLinesStart: finding.startLine,
        relevantLinesEnd: finding.endLine,
        label: 'security',
        severity: SEVERITY_BY_LEVEL[finding.severity],
        // No attribution in the body: which rule fired is our telemetry, not
        // something the PR author needs to read. It rides on `evidence`.
        suggestionContent: finding.message,
        oneSentenceSummary: finding.message,
        // Deterministic findings carry no rewrite: the rule proves the pattern
        // is present, not what the correct replacement is here.
        improvedCode: '',
        language: '',
        evidence: {
            source: RULE_PACK_SOURCE,
            ruleId: finding.ruleId,
            analyzerSeverity: finding.severity,
        },
    }));
}
