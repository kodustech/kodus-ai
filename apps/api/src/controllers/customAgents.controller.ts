import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Inject,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
    ApiBearerAuth,
    ApiOperation,
    ApiQuery,
    ApiTags,
} from '@nestjs/swagger';

import { GetCustomAgentsStatusUseCase } from '@libs/code-review/application/use-cases/custom-agents/get-custom-agents-status.use-case';
import { ResolveCustomAgentUseCase } from '@libs/code-review/application/use-cases/custom-agents/resolve-custom-agent.use-case';
import { TryCustomAgentUseCase } from '@libs/code-review/application/use-cases/custom-agents/try-custom-agent.use-case';
import type { KnowledgeItem } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import {
    checkPermissions,
    checkRepoPermissions,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';

import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import { TenantScopeGuard } from '../guards/tenant-scope.guard';

const canReadSettings = checkPermissions({
    action: Action.Read,
    resource: ResourceType.CodeReviewSettings,
});

// A try spends model calls, runs the agent's tools and returns findings on a
// pull request's code: it is scoped to the repository, like a settings edit.
const canEditSettings = checkRepoPermissions({
    action: Action.Update,
    resource: ResourceType.CodeReviewSettings,
    repo: { key: { body: 'repositoryId' } },
});

/** What the custom agent settings pages read and test (#2172). */
@ApiTags('Custom Agents')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@Controller('code-review/custom-agents')
// The stored config is looked up by team id alone: the team from the request
// must belong to the caller's organization.
@UseGuards(TenantScopeGuard)
export class CustomAgentsController {
    constructor(
        @Inject(REQUEST)
        private readonly request: UserRequest,
        private readonly resolveCustomAgent: ResolveCustomAgentUseCase,
        private readonly tryCustomAgent: TryCustomAgentUseCase,
        private readonly customAgentsStatus: GetCustomAgentsStatusUseCase,
    ) {}

    private organizationId(): string {
        const organizationId = this.request?.user?.organization?.uuid;
        if (!organizationId) {
            throw new BadRequestException('Organization not found');
        }
        return organizationId;
    }

    @Post('resolve')
    @ApiOperation({
        summary: 'Check a draft agent',
        description:
            "Checks a draft agent and the skills and docs it links against the repository's default branch: skill validation, doc token counts, ast-grep rule count, read-only MCP tools, and files that are also Kody Rules sources.",
    })
    @UseGuards(PolicyGuard)
    @CheckPolicies(canReadSettings)
    async resolve(
        @Body()
        body: {
            teamId: string;
            repositoryId: string;
            agent?: unknown;
            knowledge?: KnowledgeItem[];
            discover?: boolean;
        },
    ) {
        if (!body?.teamId || !body?.repositoryId) {
            throw new BadRequestException(
                'teamId and repositoryId are required',
            );
        }
        return this.resolveCustomAgent.execute({
            organizationAndTeamData: {
                organizationId: this.organizationId(),
                teamId: body.teamId,
            },
            repositoryId: body.repositoryId,
            agent: body.agent,
            knowledge: body.knowledge,
            discover: body.discover === true,
        });
    }

    @Post('try')
    @ApiOperation({
        summary: 'Try an agent on a pull request',
        description:
            'Runs one agent, saved or not, on a pull request without posting, and returns the skills it opened, its tool calls, and each finding with the verdict and the reason.',
    })
    @UseGuards(PolicyGuard)
    @CheckPolicies(canEditSettings)
    async try(
        @Body()
        body: {
            teamId: string;
            repositoryId: string;
            prUrl: string;
            agent: unknown;
            knowledge?: KnowledgeItem[];
        },
    ) {
        if (
            !body?.teamId ||
            !body?.repositoryId ||
            !body?.prUrl?.trim() ||
            !body?.agent
        ) {
            throw new BadRequestException(
                'teamId, repositoryId, prUrl and agent are required',
            );
        }
        return this.tryCustomAgent.execute({
            organizationAndTeamData: {
                organizationId: this.organizationId(),
                teamId: body.teamId,
            },
            repositoryId: body.repositoryId,
            prUrl: body.prUrl.trim(),
            agent: body.agent,
            knowledge: body.knowledge,
        });
    }

    @Get('status')
    @ApiOperation({
        summary: 'Custom agents status',
        description:
            'Per agent over the last 30 days: pull requests with findings, findings posted, kept in shadow, and dropped.',
    })
    @ApiQuery({ name: 'teamId', type: String, required: true })
    @ApiQuery({ name: 'repositoryId', type: String, required: true })
    @UseGuards(PolicyGuard)
    @CheckPolicies(canReadSettings)
    async status(
        @Query('teamId') teamId: string,
        @Query('repositoryId') repositoryId: string,
    ) {
        if (!teamId || !repositoryId) {
            throw new BadRequestException(
                'teamId and repositoryId are required',
            );
        }
        return this.customAgentsStatus.execute({
            organizationId: this.organizationId(),
            repositoryId,
        });
    }
}
