import { createHash } from 'node:crypto';
import { CHANGE_RISK_PROMPT } from './change-risk-prompt';
import {
    riskCriteriaSchema,
    type RiskCriterion,
} from '@libs/core/infrastructure/config/types/general/risk-assessment';
import {
    BYOK_SECRET_SETTINGS,
    type NormalizedModel,
} from '@libs/llm/byok-config';

/** The assessment reads title/body as well as code; edits invalidate its reuse. */
export function prRiskDescriptionKey(input: { title?: string; body?: string }) {
    return createHash('sha256')
        .update(
            JSON.stringify({
                title: input.title ?? '',
                body: input.body ?? '',
            }),
        )
        .digest('hex');
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
                version: 11,
                prompt: CHANGE_RISK_PROMPT,
                criteria: riskCriteriaSchema.parse(input.criteria ?? []),
                language: input.language ?? 'en-US',
                model: identity(input.modelSlot),
                fallback: identity(input.modelSlot?.fallback),
            }),
        )
        .digest('hex');
}
