import * as yaml from 'js-yaml';

import {
    CentralizedConfigPrService,
    CentralizedMutationPullRequestRequest,
} from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IKodyRule,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

export type KodyRuleMutationOperation = 'create' | 'update' | 'delete';

interface BuildKodyRuleCentralizedMutationRequestParams {
    centralizedConfigPrService: CentralizedConfigPrService;
    organizationAndTeamData: OrganizationAndTeamData;
    repositoryId?: string;
    groupFolderName?: string;
    ruleContent: Partial<IKodyRule>;
    ruleType: KodyRulesType;
    operation: KodyRuleMutationOperation;
}

export function buildKodyRuleCentralizedMutationRequest(
    params: BuildKodyRuleCentralizedMutationRequestParams,
): CentralizedMutationPullRequestRequest {
    const isMemory = params.ruleType === KodyRulesType.MEMORY;
    const rulesDirectory = isMemory ? 'memories' : 'review';
    const operationLabel =
        params.operation === 'delete' ? 'remove' : params.operation;

    return {
        organizationAndTeamData: params.organizationAndTeamData,
        repositoryId: params.repositoryId,
        files: ({ repositoryFolder }) => {
            const path = buildKodyRuleCentralizedFilePath({
                centralizedConfigPrService: params.centralizedConfigPrService,
                repositoryFolder,
                rulesDirectory,
                ruleContent: params.ruleContent,
                groupFolderName: params.groupFolderName,
            });

            if (params.operation === 'delete') {
                return [{ path, operation: 'delete' }];
            }

            return [
                {
                    path,
                    content: formatRuleToYaml(params.ruleContent),
                    operation: 'upsert',
                },
            ];
        },
        title: ({ repositoryFolder }) =>
            `${params.operation === 'delete' ? 'Remove' : 'Update'} ${isMemory ? 'Kody Memory' : 'Kody Rule'} from ${repositoryFolder}`,
        description:
            params.operation === 'delete'
                ? 'This pull request proposes removing a centralized Kody file.'
                : 'This pull request proposes a centralized Kody configuration change.',
        commitMessage: `${operationLabel} ${isMemory ? 'memory' : 'rule'} via centralized config`,
        sourceBranch: () =>
            `kodus-centralized-${params.ruleType}-${params.operation}-${Date.now()}`,
    };
}

export function buildKodyRuleCentralizedFilePath(params: {
    centralizedConfigPrService: CentralizedConfigPrService;
    repositoryFolder: string;
    rulesDirectory: string;
    ruleContent: Partial<IKodyRule>;
    groupFolderName?: string;
}): string {
    const normalizedPath = normalizeCentralizedPath(
        params.ruleContent.centralizedConfig?.path,
    );

    if (normalizedPath) {
        return normalizedPath;
    }

    const fileName = `${params.centralizedConfigPrService.sanitizeFileName(params.ruleContent.title, 'rule')}.yml`;

    if (params.groupFolderName) {
        return params.centralizedConfigPrService.buildDirectoryGroupRulesPath(
            params.repositoryFolder,
            params.groupFolderName,
            params.rulesDirectory,
            fileName,
        );
    }

    return params.centralizedConfigPrService.buildCentralizedPath({
        repositoryFolder: params.repositoryFolder,
        relativePath: `.kody-rules/${params.rulesDirectory}/${fileName}`,
    });
}

function normalizeCentralizedPath(path?: string): string | null {
    const normalized = path?.trim();

    if (
        !normalized ||
        normalized.startsWith('/') ||
        normalized.includes('..')
    ) {
        return null;
    }

    return normalized;
}

export function formatRuleToYaml(rule: Partial<IKodyRule>): string {
    const ruleForYaml = {
        title: rule.title,
        rule: rule.rule,
        ...(rule.severity ? { severity: rule.severity } : {}),
        ...(rule.scope ? { scope: rule.scope } : {}),
        ...(rule.path ? { path: rule.path } : {}),
        ...(rule.examples ? { examples: rule.examples } : {}),
        ...(rule.inheritance ? { inheritance: rule.inheritance } : {}),
    };

    return yaml.dump(ruleForYaml);
}
