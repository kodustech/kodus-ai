import { KodyRulesOrigin } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import { isIdeRuleSource } from './file-patterns';

/** The values `origin` held before it was widened to {@link KodyRulesOrigin}. */
export type LegacyKodyRuleOrigin = 'user' | 'library' | 'generated';

export interface OriginInferenceInput {
    origin?: KodyRulesOrigin | null;
    sourcePath?: string | null;
    legacyOrigin?: LegacyKodyRuleOrigin | null;
}

/**
 * Map a rule onto a {@link KodyRulesOrigin}, used to backfill rows that predate
 * the widened enum. An already-explicit `origin` is returned as-is; otherwise
 * the legacy value and `sourcePath` are mapped. The IDE-file check precedes the
 * `generated` check so a synced file stays `REPO_FILE_SYNC` whatever authored it.
 */
export function resolveKodyRuleOrigin(
    input: OriginInferenceInput,
): KodyRulesOrigin {
    if (input.origin) {
        return input.origin;
    }

    if (input.legacyOrigin === 'library') {
        return KodyRulesOrigin.LIBRARY;
    }

    if (isIdeRuleSource(input.sourcePath)) {
        return KodyRulesOrigin.REPO_FILE_SYNC;
    }

    if (input.legacyOrigin === 'generated') {
        return KodyRulesOrigin.PAST_REVIEWS;
    }

    return KodyRulesOrigin.MANUAL;
}

/** Origins that represent machine-generated knowledge (rules or memories). */
export function isGeneratedKodyRuleOrigin(
    origin?: KodyRulesOrigin | null,
): boolean {
    return (
        origin === KodyRulesOrigin.PAST_REVIEWS ||
        origin === KodyRulesOrigin.ONBOARDING_REPO_ANALYSIS ||
        origin === KodyRulesOrigin.MCP_AGENT
    );
}
