import { createHash } from 'node:crypto';
import { CHANGE_RISK_PROMPT } from './change-risk-prompt';
import {
    riskCriteriaSchema,
    type RiskCriterion,
} from '@libs/core/infrastructure/config/types/general/risk-assessment';
import type { NormalizedModel } from '@libs/llm/byok-config';

export function prRiskConfigurationKey(input: {
    criteria?: RiskCriterion[];
    language?: string;
    modelSlot?: NormalizedModel;
}): string {
    const identity = (slot: NormalizedModel | undefined) =>
        slot
            ? {
                  id: slot.byokModelId,
                  credentialId: slot.credentialId,
                  provider: slot.provider,
                  model: slot.model,
              }
            : null;
    return createHash('sha256')
        .update(
            JSON.stringify({
                version: 8,
                prompt: CHANGE_RISK_PROMPT,
                criteria: riskCriteriaSchema.parse(input.criteria ?? []),
                language: input.language ?? 'en-US',
                model: identity(input.modelSlot),
                fallback: identity(input.modelSlot?.fallback),
            }),
        )
        .digest('hex');
}
