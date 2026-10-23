/**
 * Pure severity-classification prompt + response parse — shared by production
 * (`classify-severity.ts`) and the severity evals so there is no prompt drift.
 */
import { V2_DEFAULT_SEVERITY_FLAGS_TEXT } from '@libs/common/utils/codeReview/v2Defaults';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';
import { samePromptText } from '@libs/common/utils/writing-guidelines';

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
    relevantLinesStart?: number;
    relevantLinesEnd?: number;
    suggestionContent: string;
    oneSentenceSummary?: string;
    existingCode?: string;
    improvedCode?: string;
}

// The levels as defined from the labelled findings of #1821 (evals/severity/definitions.md),
// with the rules and examples of test 17b (evals/severity/prompts.js r17b).
const SEVERITY_INSTRUCTIONS = `Assign each code review comment below one severity: low, medium, high or critical. Return one item per comment index.

Rate the problem as the comment states it. Take its facts about the code as true and rate how bad the stated consequence would be; do not try to decide whether the claim is correct. An attack the comment only asserts, without showing how it is carried out, counts as the weakness. Do not raise the severity because the comment uses alarming words, and do not lower it because the fix is small.

Judge consequences supported by the comment and stated trigger. Do not invent scale, exploit success, alternative routes, recovery, or whether behavior is newly added. Take the comment's facts about the code as true, but not the success of an attack it only asserts: an exploit stated without its concrete path (a timing side channel, a theoretical attack chain) is rated by the weakness, which is medium.

**Low:** Maintenance, cosmetic inconsistencies, minor redundant work, log content (a missing, wrong or misleading log line, log field or log context), missing coverage of unchanged or trivial code, or fixture-fidelity gaps without demonstrated false verification. Includes test-only resource leaks without broader consequences. Small bounded N+1 loops are low; N+1 alone does not establish significant load.

**Medium:** Meaningful bounded defects: wrong metrics, alerts or other secondary output, misleading messages or feedback shown to users, isolated request failures, failures confined to one record or embed even when they repeat for it, ordinary invalid-input handling, significant extra work, or limited security/privacy weaknesses. Lint or CI failures that block only development are medium. Problems no current code path reaches (only a future caller, a custom extension or a configuration nobody uses yet) are at most medium. Missing coverage of substantive behavior the change adds is medium. Tests that falsely verify their claimed behavior are medium.

**High:** A supported operational path becomes unusable for valid inputs, including an identified UI path; an essential durable effect fails; a primary entity lacks its required identifier; operational data is wrongly destroyed; or a material security or operational admission control is bypassed. Includes demonstrated production outages and blocked production builds or deployments.

Admission controls include seat/device/licensing caps, permitted booking windows (including date overrides and working hours), participation blocklists, and booking-lifecycle eligibility. Require actual acceptance of an ineligible booking, guest, or device; cosmetic or diagnostic mentions do not qualify. Wrongly denying a legitimate one is not a bypass: it is medium unless it makes a supported path unusable.

Essential durable effects include the system’s primary records and calendar integrations. Errors confined to recipient attachments or emails are secondary output unless a stronger consequence is supported.

**Critical:** A concrete path to authentication-factor bypass by someone who holds no valid factor, broad unauthorized administration, attacker-controlled browser/server execution, or systemic destructive loss of an entire queue or continuing work stream (work silently marked done without being processed). Work that is re-processed or duplicated instead of lost is medium. Accepting a revoked or superseded credential that the attacker must already hold is high.

Apply the highest supported consequence. Cohort size, feature flags, rarity, and concurrency do not lower severity. Bounded duplication is medium unless it violates admission or breaks an essential operational update. Persistent cosmetic/metric errors remain bounded. Missing fields, missing await, or resource growth alone do not establish outages. Judge tests by verification harm.

How often the trigger occurs never lowers the level: a failure that happens only for users or records missing some row, only when a setting, flag or environment variable is used, only in one view, or only when a dependency throws is rated by what fails when it happens.

Examples (invented, for calibration only):
- "The helper is still named loadXml although it now reads JSON." -> low
- "The delete handler logs without the request-scoped fields, so its lines lack the user id." -> low (log content)
- "The new sorting branch has no test." -> medium (the change adds that behavior)
- "The unused import fails the lint step in CI." -> medium (blocks development only)
- "The secret is compared with !==, which leaks timing; an attacker could recover it." -> medium (asserted exploit, rated by the weakness)
- "On shutdown the last offsets are not committed, so those messages are processed again." -> medium (re-processed, not lost)
- "Two concurrent sign-ups can both pass the seat count, so the team ends up over its seat limit." -> high (admission cap bypassed; concurrency does not lower it)
- "Users without a billing profile get a 500 on the settings page." -> high
- "A viewer can call the endpoint that grants administrator access." -> critical
- "A failed send still marks every job of the batch as done, so they are never retried." -> critical (work marked done without being processed)

More examples of high (invented):
- "Projects created before the migration have no owner row, so opening their settings returns a 500." -> high (a supported path fails for those projects)
- "The flag check always returns false, so the export feature cannot be turned on." -> high (a supported feature is unusable)
- "The rate limit is read before environment overrides are applied, so setting it through the environment leaves it disabled." -> high (an admission control is not enforced)
- "The archive action is gated on a field the list view never loads, so archiving is impossible from the list." -> high (a UI path is unusable)
- "The order is saved, but the warehouse sync after it is not handled; if it throws, the order exists without its shipment." -> high (an essential durable effect diverges)`;

const LEVELS = ['critical', 'high', 'medium', 'low'] as const;

let shippedFlags: SeverityFlags[] | undefined;

/**
 * Every criteria text Kody has shipped as a default: the classifier's fallback,
 * the settings page's (default-kodus-config.yml until 2026-03) and the current
 * default-kodus-config.yml, which the team's config carries when it kept them.
 */
function shippedSeverityFlags(): SeverityFlags[] {
    if (shippedFlags === undefined) {
        shippedFlags = [
            DEFAULT_SEVERITY_FLAGS,
            V2_DEFAULT_SEVERITY_FLAGS_TEXT,
            currentDefaultFlags(),
        ].filter(Boolean);
    }
    return shippedFlags;
}

function currentDefaultFlags(): SeverityFlags | undefined {
    try {
        return getDefaultKodusConfigFile()?.v2PromptOverrides?.severity?.flags;
    } catch {
        return undefined;
    }
}

/** Whether the team wrote its own criteria for any level, instead of keeping a shipped default. */
export function hasCustomSeverityFlags(flags?: SeverityFlags): boolean {
    return LEVELS.some((level) => {
        const value = flags?.[level];
        return (
            typeof value === 'string' &&
            value.trim().length > 0 &&
            !shippedSeverityFlags().some((shipped) =>
                samePromptText(value, shipped[level]),
            )
        );
    });
}

const RESPONSE_FORMAT = `Respond with ONLY a JSON object:
\`\`\`json
{"classifications": [{"index": 0, "severity": "high", "reason": "brief reason"}]}
\`\`\``;

/**
 * The severity prompt: the defined levels by default; a team that wrote its own
 * criteria for any level keeps the criteria prompt with them.
 */
export function buildSeverityPrompt(
    suggestions: SuggestionForClassification[],
    flags?: SeverityFlags,
): string {
    if (hasCustomSeverityFlags(flags)) {
        return buildCriteriaSeverityPrompt(suggestions, flags);
    }

    const comments = suggestions
        .map((s, i) => {
            const start = s?.relevantLinesStart;
            const lines = start ? `, lines ${start}-${s.relevantLinesEnd || start}` : '';
            return `[${i}] File: ${s?.relevantFile || ''}${lines}\nIssue: ${(s?.suggestionContent || '').trim()}`;
        })
        .join('\n\n');

    return [
        SEVERITY_INSTRUCTIONS,
        'Comments:',
        comments,
        RESPONSE_FORMAT,
    ]
        .filter(Boolean)
        .join('\n\n');
}

/** The prompt over the team's own criteria for each level (the defaults fill the rest). */
export function buildCriteriaSeverityPrompt(
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
