import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';

import type { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { CheckPolicies, PolicyGuard } from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { ListPullRequestRunsUseCase } from '@libs/runtime/api/application/use-cases/pull-request-runs.use-case';
import { RequestPullRequestRunUseCase } from '@libs/runtime/api/application/use-cases/request-pull-request-run.use-case';
import { MAX_PULL_REQUESTS_PER_READ } from '@libs/runtime/api/domain/pull-request-runs';

import { ApiStandardResponses } from '../../docs/api-standard-responses.decorator';
import { RuntimeReleaseGuard } from './runtime-release.guard';

const ID_MAX = 128;

export class PullRequestRefDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(ID_MAX)
    @ApiProperty()
    repositoryId: string;

    @IsInt()
    @Min(1)
    @ApiProperty()
    prNumber: number;
}

export class RequestPullRequestRunDto extends PullRequestRefDto {
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    @MaxLength(ID_MAX)
    @ApiPropertyOptional({ description: 'The environment to run in; default: every environment of the repository that triggers on its pull requests.' })
    environmentId?: string;
}

export class ListPullRequestRunsDto {
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(MAX_PULL_REQUESTS_PER_READ)
    @ValidateNested({ each: true })
    @Type(() => PullRequestRefDto)
    @ApiProperty({ type: [PullRequestRefDto], description: `1 to ${MAX_PULL_REQUESTS_PER_READ} pull requests.` })
    pullRequests: PullRequestRefDto[];
}

/**
 * Kody Runtime on the pull requests screens: the Runtime state of a page of
 * PRs in one call, and "Run on this PR". A read of many PRs is a POST so the
 * list travels in the body, not in a URL.
 */
@ApiTags('Kody Runtime')
@ApiStandardResponses()
@Controller('runtime/pull-request-runs')
@UseGuards(RuntimeReleaseGuard)
export class RuntimePullRequestRunsController {
    constructor(
        private readonly listUseCase: ListPullRequestRunsUseCase,
        private readonly requestUseCase: RequestPullRequestRunUseCase,
    ) {}

    @Post()
    @HttpCode(200)
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.RuntimeRun }))
    @ApiOperation({
        summary: 'Runtime state of pull requests',
        description: 'Per PR: its environment, its latest Run and the latest Run of each commit. PRs of repositories the caller cannot read are left out.',
    })
    @ApiOkResponse({
        description:
            '{ pullRequests: [{ repositoryId, prNumber, environment, environments?, canRequestRun, latest, commits }] }; each environment carries its `triggers` and the `repositoryIds` it holds (Run on this PR needs Create over each).',
    })
    list(@Req() req: UserRequest, @Body() body: ListPullRequestRunsDto) {
        return this.listUseCase.execute({ user: req.user, body });
    }

    @Post('request')
    @HttpCode(202)
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({ action: Action.Create, resource: ResourceType.RuntimeRun }))
    @ApiOperation({
        summary: 'Run on this PR',
        description:
            "A Run on the pull request's current head, through the outbox: in the environment named, or in every environment of the repository that triggers on it (`runs` lists them when there are several). 409 when no environment triggers on the repository, or Kody Runtime is off for one of the environment's repositories; 429 past the daily count of Runs asked by hand on the PR (shared with `@kody runtime` and Run again).",
    })
    request(@Req() req: UserRequest, @Body() body: RequestPullRequestRunDto) {
        return this.requestUseCase.execute({ user: req.user, body });
    }
}
