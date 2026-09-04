import { Transform, Type } from 'class-transformer';
import {
    IsOptional,
    IsString,
    Min,
    Max,
    IsBoolean,
    IsInt,
    IsIn,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { PULL_REQUEST_AUTHOR_POLICIES } from './pull-request-author-policy.constants';

export class EnrichedPullRequestsQueryDto {
    @IsOptional()
    @IsString()
    @ApiPropertyOptional()
    repositoryId?: string;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional()
    repositoryName?: string;

    @IsOptional()
    @Transform(({ value }) => parseInt(value))
    @Min(1)
    @Max(100)
    @ApiPropertyOptional()
    limit?: number = 30;

    @IsOptional()
    @Transform(({ value }) => parseInt(value))
    @Min(1)
    @ApiPropertyOptional()
    page?: number = 1;

    /**
     * Opaque resume point, echoed back from the previous response's
     * `pagination.nextCursor`.
     *
     * `page` cannot express where the previous page stopped. Filling a page
     * loops over batches and discards rows that fail a post-query filter, so a
     * page of 30 can consume 60 or 300 executions; `(page - 1) * limit` then
     * restarts inside the window that page already served. The cursor carries
     * the position of the last execution actually READ.
     *
     * `page` is still honoured when no cursor is given — first page, an old
     * client, or a deliberate jump to an offset.
     */
    @IsOptional()
    @IsString()
    @ApiPropertyOptional({
        description:
            'Resume point from the previous response (pagination.nextCursor). Takes precedence over `page`.',
    })
    cursor?: string;

    @IsOptional()
    @IsBoolean()
    @Type(() => String)
    @Transform(({ value }) => {
        if (value === undefined || value === null || value === '') {
            return undefined;
        }

        const normalized = String(value).trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;

        return undefined;
    })
    @ApiPropertyOptional()
    hasSentSuggestions?: boolean;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional()
    pullRequestTitle?: string;

    @IsOptional()
    @Transform(({ value }) => parseInt(value))
    @IsInt()
    @ApiPropertyOptional()
    pullRequestNumber?: number;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional()
    teamId?: string;

    @IsOptional()
    @IsString()
    @IsIn(PULL_REQUEST_AUTHOR_POLICIES)
    @ApiPropertyOptional({
        enum: PULL_REQUEST_AUTHOR_POLICIES,
        description:
            'Filter pull requests by author policy: all, reviewable (not excluded), or excluded.',
    })
    authorPolicy?: (typeof PULL_REQUEST_AUTHOR_POLICIES)[number];

    @IsOptional()
    @IsString()
    @IsIn(Object.values(AutomationStatus))
    @ApiPropertyOptional({
        enum: AutomationStatus,
        description: 'Filter by the execution review status.',
    })
    status?: AutomationStatus;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional({
        description: 'Only executions created on/after this ISO date.',
    })
    createdAtFrom?: string;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional({
        description: 'Only executions created on/before this ISO date.',
    })
    createdAtTo?: string;

    @IsOptional()
    @IsString()
    @Transform(({ value }) =>
        typeof value === 'string' ? value.trim().toLowerCase() : value,
    )
    @IsIn(Object.values(SeverityLevel))
    @ApiPropertyOptional({
        enum: SeverityLevel,
        description:
            'Only PRs with at least one delivered suggestion of this severity.',
    })
    severity?: SeverityLevel;

    @IsOptional()
    @IsString()
    @Transform(({ value }) =>
        typeof value === 'string' ? value.trim().toLowerCase() : value,
    )
    @ApiPropertyOptional({
        description:
            'Only PRs with at least one delivered suggestion of this category (label).',
    })
    category?: string;

    @IsOptional()
    @IsBoolean()
    @Type(() => String)
    @Transform(({ value }) => {
        if (value === undefined || value === null || value === '') {
            return undefined;
        }
        const normalized = String(value).trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
        return undefined;
    })
    @ApiPropertyOptional({
        description:
            'Only PRs that delivered at least one critical or high suggestion.',
    })
    needsAttention?: boolean;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional({
        description:
            "Filter to PRs authored by the current user ('me') — matched by git identity.",
    })
    author?: string;
}
