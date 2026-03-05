import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    CreateKodyRuleDto,
    KodyRuleSeverity,
} from '@libs/ee/kodyRules/dtos/create-kody-rule.dto';

import {
    CreateOrUpdateMemoryResult,
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
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
    >
>;

interface KodyRulesResponse extends BaseResponse {
    data: Partial<IKodyRule>[];
}

interface CreateKodyRuleResponse extends BaseResponse {
    data: Partial<IKodyRule>;
}

interface CreateMemoryRuleResponse extends BaseResponse {
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

interface FindMemoriesResponse extends BaseResponse {
    data: FindMemoriesResult[];
}

@Injectable()
export class KodyRulesTools {
    private readonly logger = createLogger(KodyRulesTools.name);
    constructor(
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
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
                'Get all active Kody Rules at organization level. Use this to see organization-wide coding standards, global rules that apply across all repositories, or when you need a complete overview of all active rules. Returns only ACTIVE status rules.',
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
                            rule.status === KodyRulesStatus.ACTIVE,
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
                'Get active Kody Rules specific to a particular repository. Use this to see repository-specific coding standards, rules that only apply to one codebase, or when analyzing rules for a specific project. More focused than get_kody_rules.',
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
                                rule.status === KodyRulesStatus.ACTIVE,
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
                            'Repository unique identifier - can be used with both scopes to limit rule to specific repository',
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
                })
                .describe(
                    'Complete rule definition with title, description, scope, and examples',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_CREATE_KODY_RULE',
            description:
                'Create a new Kody Rule with custom scope and severity. pull_request scope: analyzes entire PR context for PR-level rules. file scope: analyzes individual files one by one for file-level rules. Rule starts in pending status.',
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
            }),
            execute: wrapToolHandler(
                async (args: InputType): Promise<CreateKodyRuleResponse> => {
                    const params: {
                        organizationAndTeamData: OrganizationAndTeamData;
                        kodyRule: KodyRuleInput;
                    } = {
                        organizationAndTeamData: {
                            organizationId: args.organizationId,
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

                    const result: Partial<IKodyRule> =
                        await this.kodyRulesService.createOrUpdate(
                            params.organizationAndTeamData,
                            params.kodyRule,
                            {
                                userId: 'kody-system-tool',
                                userEmail: 'kody@kodus.io',
                            },
                        );

                    return {
                        success: true,
                        count: 1,
                        data: result,
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
                            'Updated repository unique identifier - can be used with both scopes to limit rule to specific repository',
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
                })
                .describe(
                    'Updated rule definition with fields to modify (only provided fields will be updated)',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_UPDATE_KODY_RULE',
            description:
                'Update an existing Kody Rule. Only the fields provided in kodyRule will be updated. Use this to modify rule details, change severity, scope, or status of existing rules.',
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
            }),
            execute: wrapToolHandler(
                async (args: InputType): Promise<CreateKodyRuleResponse> => {
                    const organizationAndTeamData = {
                        organizationId: args.organizationId,
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

                    const result =
                        await this.kodyRulesService.updateRuleWithLogging(
                            organizationAndTeamData,
                            kodyRule,
                            userInfo,
                        );

                    return {
                        success: true,
                        count: 1,
                        data: result,
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
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_DELETE_KODY_RULE',
            description:
                'Delete a Kody Rule permanently from the system. This action cannot be undone. Use this to remove rules that are no longer needed or relevant.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                message: z.string().optional(),
            }),
            execute: wrapToolHandler(
                async (args: InputType): Promise<BaseResponse> => {
                    const organizationAndTeamData = {
                        organizationId: args.organizationId,
                    };

                    const userInfo = {
                        userId: 'kody-delete-mcp-tool',
                        userEmail: 'kody@kodus.io',
                    };

                    const result =
                        await this.kodyRulesService.deleteRuleWithLogging(
                            organizationAndTeamData,
                            args.ruleId,
                            userInfo,
                        );

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
                'Capture a memory, preference, or coding rule derived from context to influence future interactions or code generation. Invoke this tool whenever the user demonstrates an explicit or implicit intent to save a memory, establish a convention, or note a preference. Focus on capturing the user intent rather than strictly evaluating it as a permanent architectural rule. After execution, ALWAYS inform the user of: (1) final decision/action (created or updated), (2) whether approval is required in UI, and (3) the provided link to navigate in UI. If status is pending, use the returned general memories page link (without ruleId/teamId); do not claim direct memory details link will work. AVOID: Transient task instructions ("Fix this now"), debugging chatter ("I see an error"), questions ("What is the deadline?"), or vague statements without clear actionable information.',
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
