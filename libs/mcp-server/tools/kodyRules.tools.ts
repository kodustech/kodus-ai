import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { CentralizedConfigPrService } from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import {
    CreateKodyRuleDto,
    KodyRuleSeverity,
} from '@libs/ee/kodyRules/dtos/create-kody-rule.dto';

import {
    CreateOrUpdateMemoryResult,
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import { DeleteRuleInOrganizationByIdKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/delete-rule-in-organization-by-id.use-case';
import {
    FindMemoriesResult,
    IKodyRule,
    IKodyRuleMemory,
    IKodyRulesExample,
    KodyRulesOrigin,
    KodyRulesScope,
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { buildKodyRuleCentralizedMutationRequest } from '@libs/centralized-config/utils/kody-rules-centralized-pr.builder';
import { buildKodyRuleAppLink } from '@libs/ee/kodyRules/utils/build-rule-link';
import { BaseResponse, McpToolDefinition } from '../types/mcp-tool.interface';
import { wrapToolHandler } from '../utils/mcp-protocol.utils';

type KodyRuleInput = Required<
    Omit<
        IKodyRule,
        | 'uuid'
        | 'createdAt'
        | 'updatedAt'
        | 'label'
        | 'extendedContext'
        | 'reason'
        | 'severity'
        | 'centralizedConfig'
        | 'sourcePath'
        | 'sourceAnchor'
        | 'contextReferenceId'
        | 'externalReferences'
        | 'syncErrors'
        | 'referenceProcessingStatus'
        | 'lastReferenceProcessedAt'
        | 'ruleHash'
        | 'requestType'
        | 'targetRuleUuid'
        | 'resolvedAt'
        | 'resolvedBy'
        // MCP-created rules never come from the IDE-sync flow, so
        // the `@kody-sync` pin doesn't apply.
        | 'pinnedSync'
    >
> & {
    severity: KodyRuleSeverity;
};

type KodyRuleMemoryInput = Required<
    Omit<
        IKodyRuleMemory,
        | 'uuid'
        | 'createdAt'
        | 'updatedAt'
        | 'label'
        | 'extendedContext'
        | 'reason'
        | 'severity'
        | 'centralizedConfig'
        | 'sourcePath'
        | 'sourceAnchor'
        | 'contextReferenceId'
        | 'externalReferences'
        | 'syncErrors'
        | 'referenceProcessingStatus'
        | 'lastReferenceProcessedAt'
        | 'ruleHash'
        | 'requestType'
        | 'targetRuleUuid'
        | 'resolvedAt'
        | 'resolvedBy'
        | 'pinnedSync'
    >
>;

interface KodyRulesResponse extends BaseResponse {
    data: Partial<IKodyRule>[];
}

interface CreateKodyRuleResponse extends BaseResponse {
    data: Partial<IKodyRule>;
    message?: string;
    prUrl?: string;
    link?: string;
}

interface CreateMemoryRuleResponse extends BaseResponse {
    message?: string;
    prUrl?: string;
    data: {
        uuid?: string;
        title?: string;
        rule?: string;
        status?: KodyRulesStatus;
        action: 'created' | 'updated' | 'skipped';
        requiresApproval: boolean;
        message: string;
        link: string;
    };
}

interface DeleteKodyRuleResponse extends BaseResponse {
    message?: string;
    prUrl?: string;
}

interface FindMemoriesResponse extends BaseResponse {
    data: FindMemoriesResult[];
}

@Injectable()
export class KodyRulesTools {
    private readonly logger = createLogger(KodyRulesTools.name);

    constructor(
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
        private readonly centralizedConfigPrService: CentralizedConfigPrService,
        private readonly deleteRuleInOrganizationByIdKodyRulesUseCase: DeleteRuleInOrganizationByIdKodyRulesUseCase,
    ) {}

    getKodyRules(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization in the system to get all organization-level rules',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_GET_KODY_RULES',
            description:
                'Get all Kody Rules at organization level. Use this to see organization-wide coding standards, global rules that apply across all repositories, or when you need a complete overview of rules. Returns rules with ACTIVE and PENDING status.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.array(
                    z.looseObject({
                        uuid: z.string().optional(),
                        title: z.string().optional(),
                        rule: z.string().optional(),
                        path: z.string().optional(),
                        status: z.enum(KodyRulesStatus).optional(),
                        severity: z.string().optional(),
                        label: z.string().optional(),
                        type: z.string().optional(),
                        examples: z
                            .array(
                                z.looseObject({
                                    snippet: z.string(),
                                    isCorrect: z.boolean(),
                                }),
                            )
                            .optional(),
                        repositoryId: z.string().optional(),
                        origin: z.enum(KodyRulesOrigin).optional(),
                        createdAt: z.iso.datetime().optional(),
                        updatedAt: z.iso.datetime().optional(),
                        reason: z.string().nullable().optional(),
                        scope: z.enum(KodyRulesScope).optional(),
                        directoryId: z.string().nullable().optional(),
                    }),
                ),
            }),
            execute: wrapToolHandler(
                async (args: InputType): Promise<KodyRulesResponse> => {
                    const params = {
                        organizationAndTeamData: {
                            organizationId: args.organizationId,
                        },
                    };

                    const entity =
                        await this.kodyRulesService.findByOrganizationId(
                            params.organizationAndTeamData.organizationId,
                        );

                    const allRules: Partial<IKodyRule>[] = entity.rules || [];

                    const rules: Partial<IKodyRule>[] = allRules.filter(
                        (rule: Partial<IKodyRule>) =>
                            rule.status === KodyRulesStatus.ACTIVE ||
                            rule.status === KodyRulesStatus.PENDING,
                    );

                    return {
                        success: true,
                        count: rules.length,
                        data: rules,
                    };
                },
            ),
        };
    }

    getKodyRulesRepository(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization in the system',
                ),
            repositoryId: z
                .string()
                .describe(
                    'Repository unique identifier to get rules specific to this repository only (not organization-wide rules)',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_GET_KODY_RULES_REPOSITORY',
            description:
                'Get Kody Rules specific to a particular repository. Use this to see repository-specific coding standards, rules that only apply to one codebase, or when analyzing rules for a specific project. More focused than get_kody_rules. Returns rules with ACTIVE and PENDING status.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.array(
                    z.looseObject({
                        uuid: z.string().optional(),
                        title: z.string().optional(),
                        rule: z.string().optional(),
                        path: z.string().optional(),
                        status: z.enum(KodyRulesStatus).optional(),
                        severity: z.string().optional(),
                        label: z.string().optional(),
                        type: z.string().optional(),
                        examples: z
                            .array(
                                z.looseObject({
                                    snippet: z.string(),
                                    isCorrect: z.boolean(),
                                }),
                            )
                            .optional(),
                        repositoryId: z.string().optional(),
                        origin: z.enum(KodyRulesOrigin).optional(),
                        createdAt: z.iso.datetime().optional(),
                        updatedAt: z.iso.datetime().optional(),
                        reason: z.string().nullable().optional(),
                        scope: z.enum(KodyRulesScope).optional(),
                        directoryId: z.string().nullable().optional(),
                    }),
                ),
            }),
            execute: wrapToolHandler(
                async (args: InputType): Promise<KodyRulesResponse> => {
                    const params = {
                        organizationAndTeamData: {
                            organizationId: args.organizationId,
                        },
                        repositoryId: args.repositoryId,
                    };

                    const entity =
                        await this.kodyRulesService.findByOrganizationId(
                            params.organizationAndTeamData.organizationId,
                        );

                    const allRules: Partial<IKodyRule>[] = entity.rules || [];

                    const repositoryRules: Partial<IKodyRule>[] =
                        allRules.filter(
                            (rule: Partial<IKodyRule>) =>
                                rule.repositoryId &&
                                rule.repositoryId === params.repositoryId &&
                                (rule.status === KodyRulesStatus.ACTIVE ||
                                    rule.status === KodyRulesStatus.PENDING),
                        );

                    return {
                        success: true,
                        count: repositoryRules?.length,
                        data: repositoryRules,
                    };
                },
            ),
        };
    }

    createKodyRule(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization in the system where the rule will be created',
                ),
            kodyRule: z
                .object({
                    title: z
                        .string()
                        .describe(
                            'Descriptive title for the rule (e.g., "Use arrow functions for components", "Avoid console.log in production")',
                        ),
                    rule: z
                        .string()
                        .describe(
                            'Detailed description of the coding rule/standard to enforce (e.g., "All React components should use arrow function syntax")',
                        ),
                    severity: z
                        .enum(KodyRuleSeverity)
                        .describe(
                            'Rule severity level: determines how violations are handled (ERROR, WARNING, INFO)',
                        ),
                    scope: z
                        .enum(KodyRulesScope)
                        .describe(
                            'Rule scope: pull_request (analyzes entire PR context), file (analyzes individual files one by one)',
                        ),
                    repositoryId: z
                        .string()
                        .optional()
                        .describe(
                            'Repository unique identifier to limit the rule to a specific repository. By default, when creating a rule from a PR suggestion, use the current repository ID. If the user explicitly asks for a global rule (e.g., "for all repositories", "organization-wide", "global", "for the entire organization"), omit this field or do not provide it so the rule defaults to global scope.',
                        ),
                    path: z
                        .string()
                        .optional()
                        .describe(
                            'File path pattern - used with FILE scope to target specific files (e.g., "src/components/*.tsx")',
                        ),
                    examples: z
                        .array(
                            z
                                .object({
                                    snippet: z
                                        .string()
                                        .describe(
                                            'Code example snippet demonstrating the rule',
                                        ),
                                    isCorrect: z
                                        .boolean()
                                        .describe(
                                            'Whether this snippet follows the rule (true) or violates it (false)',
                                        ),
                                })
                                .describe(
                                    'Code example showing correct or incorrect usage of the rule',
                                ),
                        )
                        .optional()
                        .describe(
                            'Array of code examples to help understand and apply the rule',
                        ),
                    directoryId: z
                        .string()
                        .optional()
                        .describe(
                            'Directory unique identifier - used with FILE scope to target specific directory',
                        ),
                    inheritance: z
                        .object({
                            inheritable: z
                                .boolean()
                                .describe(
                                    'Whether this rule can be inherited by sub-repositories or directories',
                                ),
                            exclude: z
                                .array(z.string())
                                .optional()
                                .describe(
                                    'List of repository or directory IDs that should NOT inherit this rule',
                                ),
                            include: z
                                .array(z.string())
                                .optional()
                                .describe(
                                    'List of repository or directory IDs that SHOULD inherit this rule (if empty, all can inherit)',
                                ),
                        })
                        .optional()
                        .describe('Rule inheritance settings'),
                    teamId: z
                        .string()
                        .optional()
                        .describe(
                            'Team UUID used to evaluate centralized config and repository mappings for PR-based changes',
                        ),
                })
                .describe(
                    'Complete rule definition with title, description, scope, and examples',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_CREATE_KODY_RULE',
            description:
                'Create a new Kody Rule with custom scope and severity. pull_request scope: analyzes entire PR context for PR-level rules. file scope: analyzes individual files one by one for file-level rules. Rule starts in pending status and must be approved in the UI before it takes effect. After execution, ALWAYS inform the user of: (1) the rule was created and is pending approval, and (2) the provided link to open the pending Kody Rules page to review and approve it. If centralized config is enabled the rule will be published to a pull request pending to be approved instead, and a prUrl is returned.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.object({
                    uuid: z.string().optional(),
                    title: z.string().optional(),
                    rule: z.string().optional(),
                    status: z.enum(KodyRulesStatus).optional(),
                }),
                message: z.string().optional(),
                prUrl: z.string().optional(),
                link: z
                    .string()
                    .optional()
                    .describe(
                        'Link to the pending Kody Rules page where the rule can be reviewed and approved',
                    ),
            }),
            execute: wrapToolHandler(
                async (args: InputType): Promise<CreateKodyRuleResponse> => {
                    const params: {
                        organizationAndTeamData: OrganizationAndTeamData;
                        kodyRule: KodyRuleInput;
                    } = {
                        organizationAndTeamData: {
                            organizationId: args.organizationId,
                            ...(args.kodyRule.teamId
                                ? { teamId: args.kodyRule.teamId }
                                : {}),
                        },
                        kodyRule: {
                            title: args.kodyRule.title,
                            type: KodyRulesType.STANDARD,
                            rule: args.kodyRule.rule,
                            severity: args.kodyRule.severity,
                            scope: args.kodyRule.scope,
                            examples: (args.kodyRule.examples ||
                                []) as IKodyRulesExample[],
                            origin: KodyRulesOrigin.GENERATED,
                            status: KodyRulesStatus.PENDING,
                            repositoryId:
                                args.kodyRule.repositoryId || 'global',
                            path:
                                (args.kodyRule.scope === KodyRulesScope.FILE
                                    ? args.kodyRule.path
                                    : '') || '',
                            directoryId:
                                (args.kodyRule.scope === KodyRulesScope.FILE
                                    ? args.kodyRule.directoryId
                                    : '') || '',
                            inheritance: {
                                inheritable:
                                    args.kodyRule.inheritance?.inheritable ??
                                    true,
                                exclude:
                                    args.kodyRule.inheritance?.exclude || [],
                                include:
                                    args.kodyRule.inheritance?.include || [],
                            },
                        },
                    };

                    const createGroupFolderName =
                        await this.centralizedConfigPrService.resolveDirectoryGroupFolderName(
                            params.organizationAndTeamData,
                            params.kodyRule.repositoryId,
                            params.kodyRule.directoryId,
                        );

                    const centralizedPr =
                        await this.centralizedConfigPrService.createMutationPullRequestIfEnabled(
                            buildKodyRuleCentralizedMutationRequest({
                                centralizedConfigPrService:
                                    this.centralizedConfigPrService,
                                organizationAndTeamData:
                                    params.organizationAndTeamData,
                                repositoryId: params.kodyRule.repositoryId,
                                groupFolderName:
                                    createGroupFolderName ?? undefined,
                                ruleContent: params.kodyRule,
                                ruleType: KodyRulesType.STANDARD,
                                operation: 'create',
                            }),
                        );

                    if (centralizedPr.mode === 'centralized-pr') {
                        return {
                            success: true,
                            count: 1,
                            data: {
                                title: params.kodyRule.title,
                                rule: params.kodyRule.rule,
                                status: KodyRulesStatus.PENDING,
                            },
                            message: centralizedPr.message,
                            prUrl: centralizedPr.prUrl,
                            link: centralizedPr.prUrl,
                        };
                    }

                    const result: Partial<IKodyRule> =
                        await this.kodyRulesService.createOrUpdate(
                            params.organizationAndTeamData,
                            params.kodyRule,
                            {
                                userId: 'kody-system-tool',
                                userEmail: 'kody@kodus.io',
                            },
                        );

                    const link = buildKodyRuleAppLink({
                        repositoryId: result?.repositoryId,
                        ruleId: result?.uuid,
                        teamId: params.organizationAndTeamData.teamId,
                        status: result?.status,
                        tab: 'review-rules',
                    });

                    const awaitingApproval =
                        result?.status === KodyRulesStatus.PENDING;
                    const message = awaitingApproval
                        ? 'Rule created and awaiting approval. Open the Kody Rules page to review and approve it.'
                        : 'Rule created. You can open it directly from the provided link.';

                    return {
                        success: true,
                        count: 1,
                        data: {
                            uuid: result?.uuid,
                            title: result?.title,
                            rule: result?.rule,
                            status: result?.status,
                        },
                        message,
                        link,
                    };
                },
            ),
        };
    }

    updateKodyRule(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization in the system',
                ),
            ruleId: z
                .string()
                .describe(
                    'Rule UUID - unique identifier of the rule to be updated',
                ),
            kodyRule: z
                .object({
                    title: z
                        .string()
                        .optional()
                        .describe(
                            'Updated title for the rule (e.g., "Use arrow functions for components", "Avoid console.log in production")',
                        ),
                    rule: z
                        .string()
                        .optional()
                        .describe(
                            'Updated detailed description of the coding rule/standard to enforce',
                        ),
                    severity: z
                        .enum(KodyRuleSeverity)
                        .optional()
                        .describe(
                            'Updated rule severity level: determines how violations are handled (ERROR, WARNING, INFO)',
                        ),
                    scope: z
                        .enum(KodyRulesScope)
                        .optional()
                        .describe(
                            'Updated rule scope: pull_request (analyzes entire PR context), file (analyzes individual files one by one)',
                        ),
                    repositoryId: z
                        .string()
                        .optional()
                        .describe(
                            'Updated repository unique identifier. Set to a specific repository ID to limit the rule to that repository, or set to "global" to make the rule apply to all repositories in the organization. Use "global" when the user asks for organization-wide, global, or all-repositories scope.',
                        ),
                    path: z
                        .string()
                        .optional()
                        .describe(
                            'Updated file path pattern - used with FILE scope to target specific files (e.g., "src/components/*.tsx")',
                        ),
                    examples: z
                        .array(
                            z
                                .object({
                                    snippet: z
                                        .string()
                                        .describe(
                                            'Code example snippet demonstrating the rule',
                                        ),
                                    isCorrect: z
                                        .boolean()
                                        .describe(
                                            'Whether this snippet follows the rule (true) or violates it (false)',
                                        ),
                                })
                                .describe(
                                    'Code example showing correct or incorrect usage of the rule',
                                ),
                        )
                        .optional()
                        .describe(
                            'Updated array of code examples to help understand and apply the rule',
                        ),
                    directoryId: z
                        .string()
                        .optional()
                        .describe(
                            'Updated directory unique identifier - used with FILE scope to target specific directory',
                        ),
                    status: z
                        .enum(KodyRulesStatus)
                        .optional()
                        .describe(
                            'Updated rule status: active, pending, rejected, or deleted',
                        ),
                    teamId: z
                        .string()
                        .optional()
                        .describe(
                            'Team UUID used to evaluate centralized config and repository mappings for PR-based changes',
                        ),
                })
                .describe(
                    'Updated rule definition with fields to modify (only provided fields will be updated)',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_UPDATE_KODY_RULE',
            description:
                'Update an existing Kody Rule. Only the fields provided in kodyRule will be updated. Use this to modify rule details, change severity, scope, or status of existing rules. After execution, ALWAYS inform the user of the provided link to open the rule in the Kody Rules page. If centralized config is enabled the update will be published to a pull request pending to be approved instead, and a prUrl is returned.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.looseObject({
                    uuid: z.string(),
                    title: z.string(),
                    rule: z.string(),
                    status: z.enum(KodyRulesStatus),
                }),
                message: z.string().optional(),
                prUrl: z.string().optional(),
                link: z
                    .string()
                    .optional()
                    .describe(
                        'Link to open the updated Kody Rule in the app (or the pull request URL when centralized config is enabled)',
                    ),
            }),
            execute: wrapToolHandler(
                async (args: InputType): Promise<CreateKodyRuleResponse> => {
                    const organizationAndTeamData = {
                        organizationId: args.organizationId,
                        ...(args.kodyRule.teamId
                            ? { teamId: args.kodyRule.teamId }
                            : {}),
                    };

                    const userInfo = {
                        userId: 'kody-update-mcp-tool',
                        userEmail: 'kody@kodus.io',
                    };

                    const kodyRule: CreateKodyRuleDto = {
                        uuid: args.ruleId,
                        type: KodyRulesType.STANDARD,
                        origin: KodyRulesOrigin.USER, // Default origin for MCP tool updates
                        ...(args.kodyRule.title && {
                            title: args.kodyRule.title,
                        }),
                        ...(args.kodyRule.rule && { rule: args.kodyRule.rule }),
                        ...(args.kodyRule.severity && {
                            severity: args.kodyRule.severity,
                        }),
                        ...(args.kodyRule.scope && {
                            scope: args.kodyRule.scope,
                        }),
                        ...(args.kodyRule.repositoryId && {
                            repositoryId: args.kodyRule.repositoryId,
                        }),
                        ...(args.kodyRule.path && { path: args.kodyRule.path }),
                        ...(args.kodyRule.examples && {
                            examples: args.kodyRule.examples.map((example) => ({
                                snippet: example.snippet || '',
                                isCorrect: example.isCorrect || false,
                            })),
                        }),
                        ...(args.kodyRule.directoryId && {
                            directoryId: args.kodyRule.directoryId,
                        }),
                        ...(args.kodyRule.status && {
                            status: args.kodyRule.status,
                        }),
                    };

                    const existingRule = await this.kodyRulesService.findById(
                        args.ruleId,
                    );

                    if (!existingRule) {
                        return {
                            success: false,
                            count: 0,
                            data: { uuid: args.ruleId },
                            message: `Rule with ID ${args.ruleId} not found.`,
                        };
                    }

                    const mergedRule = {
                        ...existingRule,
                        ...kodyRule,
                        uuid: args.ruleId,
                        repositoryId:
                            kodyRule.repositoryId ||
                            existingRule.repositoryId ||
                            'global',
                        type: KodyRulesType.STANDARD,
                        status:
                            kodyRule.status ||
                            existingRule.status ||
                            KodyRulesStatus.PENDING,
                    } as CreateKodyRuleDto;

                    const updateGroupFolderName =
                        await this.centralizedConfigPrService.resolveDirectoryGroupFolderName(
                            organizationAndTeamData,
                            mergedRule.repositoryId,
                            mergedRule.directoryId,
                        );

                    const centralizedPr =
                        await this.centralizedConfigPrService.createMutationPullRequestIfEnabled(
                            buildKodyRuleCentralizedMutationRequest({
                                centralizedConfigPrService:
                                    this.centralizedConfigPrService,
                                organizationAndTeamData,
                                repositoryId: mergedRule.repositoryId,
                                groupFolderName:
                                    updateGroupFolderName ?? undefined,
                                ruleContent: mergedRule,
                                ruleType: KodyRulesType.STANDARD,
                                operation: 'update',
                            }),
                        );

                    if (centralizedPr.mode === 'centralized-pr') {
                        return {
                            success: true,
                            count: 1,
                            data: {
                                uuid: args.ruleId,
                                title: mergedRule.title,
                                rule: mergedRule.rule,
                                status: mergedRule.status,
                            },
                            message: centralizedPr.message,
                            prUrl: centralizedPr.prUrl,
                            link: centralizedPr.prUrl,
                        };
                    }

                    const result =
                        await this.kodyRulesService.updateRuleWithLogging(
                            organizationAndTeamData,
                            mergedRule,
                            userInfo,
                        );

                    const link = buildKodyRuleAppLink({
                        repositoryId: result?.repositoryId,
                        ruleId: result?.uuid,
                        teamId: organizationAndTeamData.teamId,
                        status: result?.status,
                        tab: 'review-rules',
                    });

                    return {
                        success: true,
                        count: 1,
                        data: result,
                        message: 'Rule updated. You can open it directly from the provided link.',
                        link,
                    };
                },
            ),
        };
    }

    deleteKodyRule(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization in the system',
                ),
            ruleId: z
                .string()
                .describe(
                    'Rule UUID - unique identifier of the rule to be deleted',
                ),
            teamId: z
                .string()
                .optional()
                .describe(
                    'Team UUID used to evaluate centralized config and repository mappings for PR-based changes',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_DELETE_KODY_RULE',
            description:
                'Delete a Kody Rule permanently from the system. This action cannot be undone. Use this to remove rules that are no longer needed or relevant. If centralized config is enabled the deletion will be published to a pull request pending to be approved.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                message: z.string().optional(),
                prUrl: z.string().optional(),
            }),
            execute: wrapToolHandler(
                async (args: InputType): Promise<DeleteKodyRuleResponse> => {
                    const result =
                        await this.deleteRuleInOrganizationByIdKodyRulesUseCase.execute(
                            args.ruleId,
                            {
                                source: 'cli',
                                organizationId: args.organizationId,
                                teamId: args.teamId,
                                userId: 'kody-delete-mcp-tool',
                                userEmail: 'kody@kodus.io',
                            },
                        );

                    if (typeof result !== 'boolean') {
                        return {
                            success: true,
                            message: result.message,
                            prUrl: result.prUrl,
                        };
                    }

                    return {
                        success: result,
                        ...(result
                            ? { message: 'Kody Rule deleted successfully' }
                            : { message: 'Failed to delete Kody Rule' }),
                    };
                },
            ),
        };
    }

    createMemoryRule(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization in the system where the memory rule will be created',
                ),
            teamId: z
                .string()
                .describe(
                    'Team UUID used to resolve repository code-review settings that control generated-memory activation behavior',
                ),
            kodyRule: z
                .object({
                    title: z
                        .string()
                        .describe(
                            'Descriptive title for the memory rule (e.g., "Project uses AWS for cloud infrastructure", "User prefers concise code examples")',
                        ),
                    rule: z
                        .string()
                        .describe(
                            'Detailed description of the memory-specific coding rule/standard to enforce (e.g., "All cloud infrastructure code should be compatible with AWS", "Provide concise code examples with less than 10 lines")',
                        ),
                    repositoryId: z
                        .string()
                        .optional()
                        .describe(
                            'Repository unique identifier - can be used to limit memory rule to specific repository, otherwise it applies globally to all repositories in the organization',
                        ),
                    directoryId: z
                        .string()
                        .optional()
                        .describe(
                            'Directory unique identifier - can be used to limit memory rule to specific directory, must also have a repositoryId defined',
                        ),
                    path: z
                        .string()
                        .optional()
                        .describe(
                            'Glob path pattern - used to limit memory rule to specific files or directories (e.g., "src/components/**" to apply to all files in components directory and subdirectories)',
                        ),
                })
                .describe(
                    'Complete memory rule definition with title, description, and optional repository or directory scope',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_CREATE_MEMORY',
            description:
                'Capture a memory, preference, or coding rule derived from context to influence future interactions or code generation. Invoke this tool whenever the user demonstrates an explicit or implicit intent to save a memory, establish a convention, or note a preference. Focus on capturing the user intent rather than strictly evaluating it as a permanent architectural rule. After execution, ALWAYS inform the user of: (1) final decision/action (created or updated), (2) whether approval is required in UI, and (3) the provided link to navigate in UI. If status is pending, use the returned general memories page link (without ruleId/teamId); do not claim direct memory details link will work. AVOID: Transient task instructions ("Fix this now"), debugging chatter ("I see an error"), questions ("What is the deadline?"), or vague statements without clear actionable information. If centralized config is enabled the memory rule will be published to a pull request pending to be approved.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.looseObject({
                    uuid: z.string(),
                    title: z.string(),
                    rule: z.string(),
                    status: z.enum(KodyRulesStatus),
                    action: z.enum(['created', 'updated', 'skipped']),
                    requiresApproval: z.boolean(),
                    message: z.string().optional(),
                    link: z
                        .string()
                        .describe('Link to view the memory in the system'),
                }),
                message: z.string().optional(),
                prUrl: z.string().optional(),
            }),
            execute: wrapToolHandler(
                async (args: InputType): Promise<CreateMemoryRuleResponse> => {
                    const params: {
                        organizationAndTeamData: OrganizationAndTeamData;
                        kodyRule: KodyRuleMemoryInput;
                    } = {
                        organizationAndTeamData: {
                            organizationId: args.organizationId,
                            teamId: args.teamId,
                        },
                        kodyRule: {
                            title: args.kodyRule.title,
                            type: KodyRulesType.MEMORY,
                            rule: args.kodyRule.rule,
                            origin: KodyRulesOrigin.GENERATED,
                            status: KodyRulesStatus.ACTIVE,
                            repositoryId:
                                args.kodyRule.repositoryId || 'global',
                            directoryId: args.kodyRule.directoryId || null,
                            path: args.kodyRule.path || null,
                        },
                    };

                    const result: CreateOrUpdateMemoryResult | null =
                        await this.kodyRulesService.createOrUpdateMemory(
                            params.organizationAndTeamData,
                            params.kodyRule,
                            {
                                userId: 'kody-memory-mcp-tool',
                                userEmail: 'kody@kodus.io',
                            },
                        );

                    const resultStatus = result?.rule?.status;
                    const awaitingApproval =
                        resultStatus === KodyRulesStatus.PENDING;
                    const action = result?.action ?? 'created';
                    const requiresApproval =
                        result?.requiresApproval ?? awaitingApproval;

                    const message = awaitingApproval
                        ? `Memory ${action}. Final decision: ${action}. Approval required in UI: ${requiresApproval ? 'yes' : 'no'}. Open the Memories page to review and approve it.`
                        : `Memory ${action}. Final decision: ${action}. Approval required in UI: ${requiresApproval ? 'yes' : 'no'}. You can open it directly from the provided link.`;

                    const link = result?.link || '';

                    return {
                        success: true,
                        count: 1,
                        data: {
                            uuid: result?.rule?.uuid,
                            title: result?.rule?.title,
                            rule: result?.rule?.rule,
                            status: resultStatus,
                            action,
                            requiresApproval,
                            message,
                            link,
                        },
                    };
                },
            ),
        };
    }

    findMemoriesRule(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization where memories are stored',
                ),
            teamId: z
                .string()
                .describe(
                    'Team UUID used to resolve repository code-review settings that control generated-memory activation behavior',
                ),
            repositoryId: z
                .string()
                .optional()
                .describe(
                    'Repository unique identifier - filter memories for a specific repository',
                ),
            directoryId: z
                .string()
                .optional()
                .describe(
                    'Directory unique identifier - filter memories for a specific directory',
                ),
            path: z
                .string()
                .optional()
                .describe(
                    'Glob path pattern used to find memories by scoped path (examples: "src/**", "**/*.ts")',
                ),
            keywords: z
                .array(z.string())
                .optional()
                .describe(
                    'Keywords to search in memory title or memory content (case-insensitive)',
                ),
            limit: z
                .number()
                .int()
                .min(1)
                .max(20)
                .optional()
                .describe(
                    'Maximum number of memories returned (default: 20, hard cap: 20)',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_FIND_MEMORIES',
            description:
                'Search and retrieve saved memories for the organization. Supports filtering by repository, directory, path glob, and keywords in title/content. Returns newest matches first.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.array(
                    z.object({
                        uuid: z.string().optional(),
                        title: z.string(),
                        rule: z.string(),
                        repositoryId: z.string(),
                        directoryId: z.string().optional(),
                        path: z.string().optional(),
                        createdAt: z.string().optional(),
                        link: z
                            .string()
                            .describe('Link to view the memory in the system')
                            .optional(),
                    }),
                ),
            }),
            execute: wrapToolHandler(
                async (args: InputType): Promise<FindMemoriesResponse> => {
                    const memories = await this.kodyRulesService.findMemories(
                        {
                            organizationId: args.organizationId,
                            teamId: args.teamId,
                        },
                        {
                            repositoryId: args.repositoryId,
                            directoryId: args.directoryId,
                            path: args.path,
                            keywords: args.keywords,
                            limit: args.limit,
                        },
                    );

                    return {
                        success: true,
                        count: memories.length,
                        data: memories,
                    };
                },
            ),
        };
    }

    getAllTools(): McpToolDefinition[] {
        return [
            this.getKodyRules(),
            this.getKodyRulesRepository(),
            this.createKodyRule(),
            this.updateKodyRule(),
            this.deleteKodyRule(),
            this.createMemoryRule(),
            this.findMemoriesRule(),
        ];
    }
}
