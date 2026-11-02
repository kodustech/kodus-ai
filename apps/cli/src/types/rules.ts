export type KodyRuleSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * What the API stores and the review pipeline compares against
 * (`KodyRulesScope` in libs/kodyRules/domain/interfaces/kodyRules.interface.ts).
 * `'pull request'` is still accepted as input for older scripts.
 */
export type KodyRuleScope = 'pull-request' | 'file';

export type KodyRuleStatus = 'active' | 'paused' | 'deleted';

export interface KodyRule {
    uuid: string;
    repositoryId?: string;
    title: string;
    rule: string;
    severity?: KodyRuleSeverity;
    scope?: KodyRuleScope;
    path?: string;
    status?: string;
    type?: string;
    directoryId?: string;
    // The plan's active-rule limit kept it paused (create-or-update.use-case.ts).
    lockedByPlan?: boolean;
}

export interface CentralizedPrResponse {
    mode: 'centralized-pr';
    prUrl?: string;
    prNumber?: number;
    reused?: boolean;
    pending?: boolean;
    message?: string;
}

export type KodyRuleMutationResult = KodyRule | CentralizedPrResponse;

export const isCentralizedPrResponse = (
    value: unknown,
): value is CentralizedPrResponse => {
    if (!value || typeof value !== 'object') {
        return false;
    }

    return (value as { mode?: string }).mode === 'centralized-pr';
};

export interface CreateKodyRuleRequest {
    title: string;
    rule: string;
    repositoryId?: string;
    severity?: KodyRuleSeverity;
    scope?: KodyRuleScope;
    path?: string;
}

export interface UpdateKodyRuleRequest {
    repositoryId?: string;
    title?: string;
    rule?: string;
    severity?: KodyRuleSeverity;
    scope?: KodyRuleScope;
    path?: string;
}

export interface ViewKodyRulesRequest {
    ruleId?: string;
    repositoryId?: string;
}

/** Body of POST /kody-rules/create-or-update (CreateKodyRuleDto). */
export interface UserKodyRulePayload {
    uuid?: string;
    title: string;
    rule: string;
    type: string;
    severity: KodyRuleSeverity;
    scope?: KodyRuleScope;
    path?: string;
    repositoryId?: string;
    origin?: string;
    status?: string;
    examples?: unknown[];
    teamId: string;
}

export interface ChangeKodyRulesStatusRequest {
    ruleIds: string[];
    status: KodyRuleStatus;
    teamId: string;
}

export type KodyRulesStatusResult = KodyRule[] | CentralizedPrResponse;
