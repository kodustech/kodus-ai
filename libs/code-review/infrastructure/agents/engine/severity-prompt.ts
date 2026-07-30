/**
 * Pure severity-classification prompt + response parse — shared by production
 * (`classify-severity.ts`) and the severity eval so there is no prompt drift.
 */

export const DEFAULT_SEVERITY_FLAGS = {
    critical:
        'Application crash/downtime. Data loss/corruption. Security breach. Critical operation failure.',
    high: 'Important functionality broken. Memory leaks causing eventual crash. Performance degradation affecting UX.',
    medium:
        'Partially broken functionality. Performance issues in specific scenarios. Incorrect but recoverable data.',
    low: 'Minor performance overhead. Incorrect metrics/logs. Rarely affecting few users. Edge-case issues.',
} as const;

export type SeverityLevel = 'critical' | 'high' | 'medium' | 'low';

export interface SeverityFlags {
    critical?: string;
    high?: string;
    medium?: string;
    low?: string;
}

export interface SuggestionForClassification {
    relevantFile: string;
    suggestionContent: string;
    oneSentenceSummary?: string;
    existingCode?: string;
    improvedCode?: string;
}

export function buildSeverityPrompt(
    suggestions: SuggestionForClassification[],
    flags?: SeverityFlags,
): string {
    const f = {
        critical: flags?.critical || DEFAULT_SEVERITY_FLAGS.critical,
        high: flags?.high || DEFAULT_SEVERITY_FLAGS.high,
        medium: flags?.medium || DEFAULT_SEVERITY_FLAGS.medium,
        low: flags?.low || DEFAULT_SEVERITY_FLAGS.low,
    };

    const suggestionsText = suggestions
        .map(
            (s, i) =>
                `[${i}] File: ${s.relevantFile}\nIssue: ${s.suggestionContent}\nSummary: ${s.oneSentenceSummary || 'N/A'}`,
        )
        .join('\n\n');

    return `Classify the severity of each code review suggestion based on these criteria:

**CRITICAL**: ${f.critical}

**HIGH**: ${f.high}

**MEDIUM**: ${f.medium}

**LOW**: ${f.low}

Suggestions to classify:

${suggestionsText}

Respond with ONLY a JSON object:
\`\`\`json
{"classifications": [{"index": 0, "severity": "high", "reason": "brief reason"}]}
\`\`\``;
}

/**
 * Parse the model response into a map of index → severity.
 * Returns `{ classifications, parseOk }`. Missing indices are left out so the
 * caller can decide whether to default them to medium.
 */
export function parseSeverityResponse(text: string): {
    classifications: Map<number, string>;
    parseOk: boolean;
} {
    const classifications = new Map<number, string>();
    if (!text) {
        return { classifications, parseOk: false };
    }

    const jsonMatch = text.match(/\{[\s\S]*"classifications"[\s\S]*\}/);
    if (!jsonMatch) {
        return { classifications, parseOk: false };
    }

    try {
        const parsed = JSON.parse(jsonMatch[0]);
        for (const c of parsed.classifications || []) {
            if (typeof c.index === 'number' && typeof c.severity === 'string') {
                classifications.set(c.index, c.severity.toLowerCase());
            }
        }
        return { classifications, parseOk: classifications.size > 0 };
    } catch {
        return { classifications, parseOk: false };
    }
}
