import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

export type KodyRuleAppLinkTab = 'memories' | 'review-rules';

export interface BuildKodyRuleAppLinkParams {
    repositoryId: string | null | undefined;
    ruleId: string | undefined;
    teamId?: string;
    status?: KodyRulesStatus;
    tab: KodyRuleAppLinkTab;
    baseUrl?: string;
}

export function buildKodyRuleAppLink({
    repositoryId,
    ruleId,
    teamId,
    status,
    tab,
    baseUrl,
}: BuildKodyRuleAppLinkParams): string {
    const resolvedBaseUrl = (
        baseUrl ?? process.env.API_USER_INVITE_BASE_URL ?? ''
    ).replace(/\/$/, '');

    if (!resolvedBaseUrl) {
        return '';
    }

    const scope =
        repositoryId && repositoryId !== 'global' ? repositoryId : 'global';

    const url = new URL(resolvedBaseUrl);

    if (status === KodyRulesStatus.PENDING || !ruleId) {
        url.pathname = `/settings/code-review/${scope}/kody-rules`;
        url.searchParams.set('tab', tab);
        return url.toString();
    }

    url.pathname = `/settings/code-review/${scope}/kody-rules/${ruleId}`;
    url.searchParams.set('tab', tab);

    if (teamId) {
        url.searchParams.set('teamId', teamId);
    }

    return url.toString();
}
