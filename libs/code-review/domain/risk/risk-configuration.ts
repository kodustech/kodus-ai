import { createHash } from 'node:crypto';
import { CHANGE_RISK_PROMPT } from './change-risk-prompt';
import { DEFAULT_RISK_CRITERIA } from './default-risk-criteria';
import {
    riskCriteriaSchema,
    type RiskCriterion,
} from '@libs/core/infrastructure/config/types/general/risk-assessment';
import {
    BYOK_SECRET_SETTINGS,
    type NormalizedModel,
} from '@libs/llm/byok-config';

/**
 * The assessment reads title/body as well as code; edits invalidate its reuse.
 * Line endings and surrounding space are normalized, so a provider returning
 * the same text with CRLF or a trailing newline is not a change.
 */
export function prRiskDescriptionKey(input: { title?: string; body?: string }) {
    return createHash('sha256')
        .update(JSON.stringify(normalizedPrText(input)))
        .digest('hex');
}

/** PR text as every risk identity compares it: LF line endings, trimmed. */
export function normalizedPrText(input: { title?: string; body?: string }) {
    const text = (value?: string) =>
        (value ?? '').replace(/\r\n?/g, '\n').trim();
    return { title: text(input.title), body: text(input.body) };
}

export function prRiskConfigurationKey(input: {
    criteria?: RiskCriterion[];
    language?: string;
    modelSlot?: NormalizedModel;
}): string {
    const identity = (slot: NormalizedModel | undefined) => {
        if (!slot) return null;
        const settings: Partial<NormalizedModel> = { ...slot };
        for (const key of [
            'apiKey',
            ...BYOK_SECRET_SETTINGS,
            'fallback',
            'route',
            'usedFallback',
        ] as const)
            delete settings[key];
        return settings;
    };
    return createHash('sha256')
        .update(
            JSON.stringify({
                version: 13,
                prompt: CHANGE_RISK_PROMPT,
                defaults: DEFAULT_RISK_CRITERIA,
                criteria: riskCriteriaSchema.parse(input.criteria ?? []),
                language: input.language ?? 'en-US',
                model: identity(input.modelSlot),
                fallback: identity(input.modelSlot?.fallback),
            }),
        )
        .digest('hex');
}
