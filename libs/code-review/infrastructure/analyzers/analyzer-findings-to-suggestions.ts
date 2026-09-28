import { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';

import { AnalyzerFinding } from './analyzer-finding.type';

/** Where a deterministic finding says it came from. */
export const ANALYZER_SOURCE = 'kodus-analyzer';

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

/** How many findings a single comment lists before it summarises the rest. */
const MAX_LISTED = 15;

/** Opening line per category, and the fallback for anything unrecognised. */
const HEADING: Record<string, (n: number) => string> = {
    dependencies: (n) =>
        n === 1
            ? 'This change introduces a dependency with a known vulnerability.'
            : `This change introduces ${n} dependencies with known vulnerabilities.`,
    secrets: (n) =>
        n === 1
            ? 'A credential appears to be committed in this change.'
            : `${n} credentials appear to be committed in this change.`,
};

const fallbackHeading = (n: number): string =>
    n === 1
        ? 'A scanner flagged one issue in this change.'
        : `A scanner flagged ${n} issues in this change.`;

/**
 * Converts deterministic findings into review suggestions, ONE PER CATEGORY.
 *
 * A comment per advisory does not survive contact with a real lockfile. Across
 * 130 real dependency PRs the worst produced 32 findings after filtering to
 * what the change actually introduced — as separate comments that is not a
 * review, it is a wall. They are the same problem to a reader ("this bump pulls
 * in vulnerable packages"), so they are published as one comment listing them.
 *
 * Provenance rides on `evidence`, so a published comment can name the rules
 * that fired instead of implying the model reasoned its way there.
 */
export function analyzerFindingsToSuggestions(
    findings: AnalyzerFinding[],
): Partial<CodeSuggestion>[] {
    // Same rule on the same line twice is one problem; different advisories on
    // one line are not, so the rule id is part of the identity.
    const unique = new Map<string, AnalyzerFinding>();
    for (const finding of findings) {
        unique.set(
            `${finding.tool ?? ''}:${finding.path}:${finding.startLine}:${finding.ruleId}`,
            finding,
        );
    }

    const byCategory = new Map<string, AnalyzerFinding[]>();
    for (const finding of unique.values()) {
        const key = finding.tool ?? 'analyzer';
        byCategory.set(key, [...(byCategory.get(key) ?? []), finding]);
    }

    return [...byCategory.entries()].map(([category, group]) =>
        toSuggestion(category, group),
    );
}

function toSuggestion(
    category: string,
    group: AnalyzerFinding[],
): Partial<CodeSuggestion> {
    // Anchor on the most severe finding; ties take the earliest line, so the
    // comment lands at the top of the run rather than somewhere in the middle.
    const anchor = [...group].sort(
        (a, b) =>
            SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
            a.path.localeCompare(b.path) ||
            a.startLine - b.startLine,
    )[0];

    const worst = group.reduce(
        (acc, f) =>
            SEVERITY_RANK[f.severity] > SEVERITY_RANK[acc] ? f.severity : acc,
        'note' as AnalyzerFinding['severity'],
    );

    const heading = (HEADING[category] ?? fallbackHeading)(group.length);
    const listed = group.slice(0, MAX_LISTED).map((f) => `- ${f.message}`);
    const remaining = group.length - listed.length;
    const body = [
        heading,
        '',
        ...listed,
        ...(remaining > 0 ? ['', `…and ${remaining} more.`] : []),
    ].join('\n');

    return {
        relevantFile: anchor.path,
        relevantLinesStart: anchor.startLine,
        relevantLinesEnd: anchor.endLine,
        label: 'security',
        severity: SEVERITY_BY_LEVEL[worst],
        // No attribution in the body: which rules fired is our telemetry, not
        // something the PR author needs to read. It rides on `evidence`.
        suggestionContent: body,
        oneSentenceSummary: heading,
        // Deterministic findings carry no rewrite: the rule proves the pattern
        // is present, not what the correct replacement is here.
        improvedCode: '',
        language: '',
        evidence: {
            source: ANALYZER_SOURCE,
            ruleId: group.map((f) => f.ruleId).join(','),
            analyzerSeverity: worst,
        },
    };
}
