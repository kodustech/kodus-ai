export type KodyRuleSeverity = 'low' | 'medium' | 'high' | 'critical';

export type KodyRuleScope = 'pull request' | 'file';

export interface KodyRule {
    uuid: string;
    repositoryId?: string;
    title: string;
    rule: string;
    severity?: KodyRuleSeverity;
    scope?: KodyRuleScope;
    path?: string;
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
