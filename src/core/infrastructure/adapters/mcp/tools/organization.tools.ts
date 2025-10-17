import { Injectable, Inject } from '@nestjs/common';
import { z } from 'zod';
import { PinoLoggerService } from '../../services/logger/pino.service';
import { wrapToolHandler } from '../utils/mcp-protocol.utils';
import { BaseResponse, McpToolDefinition } from '../types/mcp-tool.interface';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@/core/domain/organization/contracts/organization.service.contract';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import {
    ITeamMembersService,
    TEAM_MEMBERS_SERVICE_TOKEN,
} from '@/core/domain/teamMembers/contracts/teamMembers.service.contract';

const OrganizationSchema = z
    .object({
        uuid: z.string(),
        name: z.string(),
        tenantName: z.string().optional(),
        platformType: z.string().optional(),
        createdAt: z.date().optional(),
        updatedAt: z.date().optional(),
    })
    .passthrough();

const TeamSchema = z
    .object({
        uuid: z.string(),
        name: z.string(),
        status: z.string().optional(),
        organizationId: z.string().optional(),
        createdAt: z.date().optional(),
        updatedAt: z.date().optional(),
    })
    .passthrough();

const TeamMemberSchema = z
    .object({
        uuid: z.string(),
        userId: z.string(),
        teamId: z.string(),
        role: z.string().optional(),
        status: z.string().optional(),
        createdAt: z.date().optional(),
        updatedAt: z.date().optional(),
    })
    .passthrough();

interface OrganizationResponse extends BaseResponse {
    data: z.infer<typeof OrganizationSchema> | null;
}

interface OrganizationsResponse extends BaseResponse {
    data: z.infer<typeof OrganizationSchema>[];
}

interface TeamsResponse extends BaseResponse {
    data: z.infer<typeof TeamSchema>[];
}

interface TeamResponse extends BaseResponse {
    data: z.infer<typeof TeamSchema> | null;
}

interface TeamMembersResponse extends BaseResponse {
    data: z.infer<typeof TeamMemberSchema>[];
}

@Injectable()
export class OrganizationTools {
    constructor(
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
        @Inject(TEAM_MEMBERS_SERVICE_TOKEN)
        private readonly teamMembersService: ITeamMembersService,
        private readonly logger: PinoLoggerService,
    ) {}

    getOrganization(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization to retrieve',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_GET_ORGANIZATION',
            description:
                'Get detailed information about a specific organization including name, tenant info, and platform type. Use this to understand organization settings and configuration.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.union([OrganizationSchema, z.null()]),
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
            },
            execute: wrapToolHandler(
                async (args: InputType): Promise<OrganizationResponse> => {
                    const organization =
                        await this.organizationService.findById(
                            args.organizationId,
                        );

                    return {
                        success: !!organization,
                        count: organization ? 1 : 0,
                        data: organization || null,
                    };
                },
                'get_organization',
                () => ({ success: false, count: 0, data: null }),
            ),
        };
    }

    listOrganizations(): McpToolDefinition {
        const inputSchema = z.object({
            name: z
                .string()
                .optional()
                .describe('Filter organizations by name (partial match)'),
            platformType: z
                .string()
                .optional()
                .describe(
                    'Filter organizations by platform type (e.g., "github", "gitlab", "azure")',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_LIST_ORGANIZATIONS',
            description:
                'List organizations with optional filtering. Use this to discover organizations, find specific orgs, or see all available organizations.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.array(OrganizationSchema),
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
                openWorldHint: true,
            },
            execute: wrapToolHandler(
                async (args: InputType): Promise<OrganizationsResponse> => {
                    const filter: any = {};
                    if (args.name) filter.name = args.name;
                    if (args.platformType) filter.platformType = args.platformType;

                    const organizations =
                        await this.organizationService.find(filter);

                    return {
                        success: true,
                        count: organizations?.length || 0,
                        data: organizations || [],
                    };
                },
                'list_organizations',
                () => ({ success: false, count: 0, data: [] }),
            ),
        };
    }

    listTeams(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization to list its teams',
                ),
            status: z
                .array(z.string())
                .optional()
                .describe(
                    'Filter teams by status (e.g., ["active"], ["pending", "active"])',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_LIST_TEAMS',
            description:
                'List all teams within an organization with optional status filtering. Use this to see organization structure, find teams, or check team status.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.array(TeamSchema),
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
                openWorldHint: true,
            },
            execute: wrapToolHandler(
                async (args: InputType): Promise<TeamsResponse> => {
                    const teams = await this.teamService.find(
                        {
                            organization: { uuid: args.organizationId },
                        },
                        args.status as any,
                    );

                    return {
                        success: true,
                        count: teams?.length || 0,
                        data: teams || [],
                    };
                },
                'list_teams',
                () => ({ success: false, count: 0, data: [] }),
            ),
        };
    }

    getTeam(): McpToolDefinition {
        const inputSchema = z.object({
            teamId: z
                .string()
                .describe(
                    'Team UUID - unique identifier for the team to retrieve',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_GET_TEAM',
            description:
                'Get detailed information about a specific team including name, status, and organization. Use this to understand team settings and membership.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.union([TeamSchema, z.null()]),
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
            },
            execute: wrapToolHandler(
                async (args: InputType): Promise<TeamResponse> => {
                    const team = await this.teamService.findById(args.teamId);

                    return {
                        success: !!team,
                        count: team ? 1 : 0,
                        data: team || null,
                    };
                },
                'get_team',
                () => ({ success: false, count: 0, data: null }),
            ),
        };
    }

    listTeamMembers(): McpToolDefinition {
        const inputSchema = z.object({
            teamId: z
                .string()
                .describe(
                    'Team UUID - unique identifier for the team to list its members',
                ),
            status: z
                .string()
                .optional()
                .describe(
                    'Filter members by status (e.g., "active", "pending", "inactive")',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_LIST_TEAM_MEMBERS',
            description:
                'List all members of a specific team with optional status filtering. Use this to see team composition, check member roles, or audit team access.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.array(TeamMemberSchema),
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
            },
            execute: wrapToolHandler(
                async (args: InputType): Promise<TeamMembersResponse> => {
                    const filter: any = { team: { uuid: args.teamId } };
                    if (args.status) filter.status = args.status;

                    const members = await this.teamMembersService.find(filter);

                    return {
                        success: true,
                        count: members?.length || 0,
                        data: members || [],
                    };
                },
                'list_team_members',
                () => ({ success: false, count: 0, data: [] }),
            ),
        };
    }

    getAllTools(): McpToolDefinition[] {
        return [
            this.getOrganization(),
            this.listOrganizations(),
            this.listTeams(),
            this.getTeam(),
            this.listTeamMembers(),
        ];
    }
}

