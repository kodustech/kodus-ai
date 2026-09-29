import { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';

import { AnalyzerFinding } from './analyzer-finding.type';

/** Where a deterministic finding says it came from. */
export const ANALYZER_SOURCE = 'kodus-analyzer';

/**
 * Whether a suggestion came from the deterministic rule pack rather than the
 * model. `evidence.source` is the only marker that survives the pipeline, so
 * it is what the dedup preference and the formatting skip both key off.
 */
export function isAnalyzerSuggestion(
    suggestion: Partial<CodeSuggestion> | undefined,
): boolean {
    return (
        (suggestion?.evidence as { source?: string } | undefined)?.source ===
        ANALYZER_SOURCE
    );
}

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
            ? 'This change introduces a package with a known vulnerability.'
            : `This change introduces ${n} packages with known vulnerabilities.`,
    secrets: (n) =>
        n === 1
            ? 'A credential appears to be committed in this change.'
            : `${n} credentials appear to be committed in this change.`,
};

/** `osv/GHSA-xxx` is our rule id; `GHSA-xxx` is what the reader looks up. */
const advisoryId = (ruleId: string): string => ruleId.replace(/^osv\//, '');

/** How many locations a repeated finding names before it counts the rest. */
const MAX_LOCATIONS = 5;

/**
 * One bullet per distinct message, carrying the locations it was found at.
 *
 * A secret scanner writes the same boilerplate sentence for every hit of a
 * rule, so a file with ten credentials published as ten identical lines that
 * named no line number. Collapsing by message says the same thing once, and
 * the locations are the part the author acts on.
 */
function locatedLines(group: AnalyzerFinding[]): string[] {
    const byMessage = new Map<string, AnalyzerFinding[]>();
    for (const finding of group) {
        byMessage.set(finding.message, [
            ...(byMessage.get(finding.message) ?? []),
            finding,
        ]);
    }

    return [...byMessage.entries()].map(([message, hits]) => {
        const locations = [
            ...new Set(hits.map((f) => `\`${f.path}:${f.startLine}\``)),
        ];
        const shown = locations.slice(0, MAX_LOCATIONS).join(', ');
        const rest =
            locations.length - Math.min(locations.length, MAX_LOCATIONS);
        const tail = rest > 0 ? ` and ${rest} more` : '';
        return `- ${shown}${tail} — ${message}`;
    });
}

/**
 * One bullet per affected package rather than per advisory.
 *
 * The advisory ids are the least actionable part: the reader upgrades a
 * package, not a CVE. One id per package is enough to look the rest up, so the
 * remainder is counted instead of listed and every package gets named.
 */
function dependencyLines(group: AnalyzerFinding[]): string[] {
    const byPackage = new Map<string, AnalyzerFinding[]>();
    for (const finding of group) {
        const key = finding.subject ?? finding.message;
        byPackage.set(key, [...(byPackage.get(key) ?? []), finding]);
    }

    return [...byPackage.entries()].map(([key, forPackage]) => {
        // A finding with no subject predates the field; its message is all we
        // have, so publish that rather than a bullet reading "undefined".
        if (!forPackage[0].subject) {
            return `- ${key}`;
        }
        const ids = [...new Set(forPackage.map((f) => advisoryId(f.ruleId)))];
        const rest = ids.length - 1;
        const tail = rest > 0 ? ` and ${rest} more` : '';
        return `- **${key}** — affected by ${ids[0]}${tail}`;
    });
}

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

    // Dependencies count and list PACKAGES; every other category is one line
    // per finding, which is already how its reader thinks about them.
    const isDependencies = category === 'dependencies';
    const lines = isDependencies ? dependencyLines(group) : locatedLines(group);

    // Dependencies count packages — one per line. Everything else counts the
    // findings themselves, because collapsing by message must not make ten
    // committed credentials read as one.
    const counted = isDependencies ? lines.length : group.length;
    const heading = (HEADING[category] ?? fallbackHeading)(counted);
    const listed = lines.slice(0, MAX_LISTED);
    const remaining = lines.length - listed.length;
    const noun = isDependencies ? ' packages' : '';
    const body = [
        heading,
        '',
        ...listed,
        ...(remaining > 0 ? ['', `…and ${remaining} more${noun}.`] : []),
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
