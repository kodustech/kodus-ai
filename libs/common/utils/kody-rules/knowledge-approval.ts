import { KodyRulesOrigin } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import { isGeneratedKodyRuleOrigin } from './resolve-origin';

export type KodyKnowledgeApprovalConfig = {
    enabled: boolean;
};

/**
 * Whether a rule/memory of the given origin needs approval before it becomes
 * active, under the resolved (global/repo/directory-merged) config. When
 * enabled, generated knowledge requires approval; imported/manual origins
 * remain active.
 */
export function requiresKnowledgeApproval(
    config: KodyKnowledgeApprovalConfig | undefined,
    origin: KodyRulesOrigin,
): boolean {
    if (!config?.enabled) {
        return false;
    }

    return isGeneratedKodyRuleOrigin(origin);
}
