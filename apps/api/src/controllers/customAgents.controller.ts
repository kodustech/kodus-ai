import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Inject,
    Param,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { GetCustomAgentsStatusUseCase } from '@libs/code-review/application/use-cases/custom-agents/get-custom-agents-status.use-case';
import { ResolveCustomAgentUseCase } from '@libs/code-review/application/use-cases/custom-agents/resolve-custom-agent.use-case';
import { TryCustomAgentUseCase } from '@libs/code-review/application/use-cases/custom-agents/try-custom-agent.use-case';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkRepoPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';

import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import {
    CustomAgentsStatusQueryDto,
    CustomAgentTryRunQueryDto,
    ResolveCustomAgentDto,
    TryCustomAgentDto,
} from '../dtos/custom-agents.dto';
import { TenantScopeGuard } from '../guards/tenant-scope.guard';

// Resolve reads the repository's knowledge and status its agents' activity:
// both are scoped to the repository the request names.
const canReadSettings = checkRepoPermissions({
    action: Action.Read,
    resource: ResourceType.CodeReviewSettings,
    repo: { key: { body: 'repositoryId', query: 'repositoryId' } },
});

// A try spends model calls, runs the agent's tools and returns findings on a
// pull request's code: it is scoped to the repository, like a settings edit.
const canEditSettings = checkRepoPermissions({
    action: Action.Update,
    resource: ResourceType.CodeReviewSettings,
    repo: { key: { body: 'repositoryId' } },
});

// Reading a try's result is scoped like starting it: the result carries the
// pull request's code and the agent's findings.
const canReadTryRun = checkRepoPermissions({
    action: Action.Update,
    resource: ResourceType.CodeReviewSettings,
    repo: { key: { query: 'repositoryId' } },
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
    async resolve(@Body() body: ResolveCustomAgentDto) {
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
            'Starts one agent, saved or not, on a pull request without posting, and returns the run id. Poll GET try/:runId for the skills it opened, its tool calls, and each finding with the verdict and the reason.',
    })
    @UseGuards(PolicyGuard)
    @CheckPolicies(canEditSettings)
    async try(@Body() body: TryCustomAgentDto) {
        return this.tryCustomAgent.start({
            organizationAndTeamData: {
                organizationId: this.organizationId(),
                teamId: body.teamId,
            },
            repositoryId: body.repositoryId,
            directoryId: body.directoryId,
            prUrl: body.prUrl,
            agent: body.agent,
            knowledge: body.knowledge,
        });
    }

    @Get('try/:runId')
    @ApiOperation({
        summary: 'Read a Try it run',
        description:
            'Returns `running` until the run ends, then `done` with the skills it opened, its tool calls and each finding with the verdict and the reason.',
    })
    @UseGuards(PolicyGuard)
    @CheckPolicies(canReadTryRun)
    async tryRun(
        @Param('runId') runId: string,
        @Query() query: CustomAgentTryRunQueryDto,
    ) {
        return this.tryCustomAgent.getRun({
            organizationAndTeamData: {
                organizationId: this.organizationId(),
                teamId: query.teamId,
            },
            repositoryId: query.repositoryId,
            runId,
        });
    }

    @Get('status')
    @ApiOperation({
        summary: 'Custom agents status',
        description:
            'Per agent over the last 30 days: pull requests with findings, findings posted, and dropped.',
    })
    @UseGuards(PolicyGuard)
    @CheckPolicies(canReadSettings)
    async status(@Query() query: CustomAgentsStatusQueryDto) {
        return this.customAgentsStatus.execute({
            organizationId: this.organizationId(),
            repositoryId: query.repositoryId,
        });
    }
}
