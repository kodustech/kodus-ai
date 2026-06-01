import type {
    KodyRuleMutationResult,
    CreateKodyRuleRequest,
    KodyRule,
    UpdateKodyRuleRequest,
    ViewKodyRulesRequest,
} from '../../types/rules.js';
import { requestWithRetry } from './api-core.js';
import type { IRulesApi } from './api.interface.js';

type RequestWithRetry = <T>(
    endpoint: string,
    options?: RequestInit,
) => Promise<T>;

export class RealRulesApi implements IRulesApi {
    constructor(
        private readonly requester: RequestWithRetry = requestWithRetry,
    ) {}

    private buildAuthHeaders(accessToken: string): Record<string, string> {
        return accessToken.startsWith('kodus_')
            ? { 'X-Team-Key': accessToken }
            : { Authorization: `Bearer ${accessToken}` };
    }

    async createRule(
        accessToken: string,
        payload: CreateKodyRuleRequest,
    ): Promise<KodyRuleMutationResult> {
        return this.requester<KodyRuleMutationResult>('/cli/kody-rules', {
            method: 'POST',
            headers: this.buildAuthHeaders(accessToken),
            body: JSON.stringify(payload),
        });
    }

    async updateRule(
        accessToken: string,
        ruleId: string,
        payload: UpdateKodyRuleRequest,
    ): Promise<KodyRuleMutationResult> {
        return this.requester<KodyRuleMutationResult>(
            `/cli/kody-rules/${encodeURIComponent(ruleId)}`,
            {
                method: 'PATCH',
                headers: this.buildAuthHeaders(accessToken),
                body: JSON.stringify(payload),
            },
        );
    }

    async viewRules(
        accessToken: string,
        query: ViewKodyRulesRequest = {},
    ): Promise<KodyRule[]> {
        const params = new URLSearchParams();
        if (query.repositoryId) {
            params.set('repositoryId', query.repositoryId);
        }
        if (query.ruleId) {
            params.set('ruleId', query.ruleId);
        }

        const queryString = params.toString();
        const endpoint = `/cli/kody-rules${queryString ? `?${queryString}` : ''}`;

        return this.requester<KodyRule[]>(endpoint, {
            headers: this.buildAuthHeaders(accessToken),
        });
    }
}
