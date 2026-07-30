import { ApiProperty } from '@nestjs/swagger';
import { ApiResponseBaseDto } from './api-response.dto';

export class PullRequestExecutionAuthorDto {
    @ApiProperty()
    id: string | number;

    @ApiProperty()
    username: string;

    @ApiProperty()
    name: string;
}

export class PullRequestAutomationExecutionDto {
    @ApiProperty({ format: 'uuid' })
    uuid: string;

    @ApiProperty()
    status: string;

    @ApiProperty({ nullable: true })
    errorMessage?: string | null;

    @ApiProperty()
    createdAt: string;

    @ApiProperty()
    updatedAt: string;

    @ApiProperty()
    origin: string;
}

export class PullRequestExecutionDto {
    @ApiProperty()
    prId: string;

    @ApiProperty()
    prNumber: number;

    @ApiProperty()
    title: string;

    @ApiProperty()
    status: string;

    @ApiProperty()
    merged: boolean;

    @ApiProperty()
    url: string;

    @ApiProperty()
    baseBranchRef: string;

    @ApiProperty()
    headBranchRef: string;

    @ApiProperty()
    repositoryName: string;

    @ApiProperty()
    repositoryId: string;

    @ApiProperty()
    openedAt: string;

    @ApiProperty()
    closedAt: string;

    @ApiProperty()
    createdAt: string;

    @ApiProperty()
    updatedAt: string;

    @ApiProperty()
    provider: string;

    @ApiProperty({ type: PullRequestExecutionAuthorDto })
    author: PullRequestExecutionAuthorDto;

    @ApiProperty()
    isDraft: boolean;

    @ApiProperty()
    compareUrl: string;

    @ApiProperty({ format: 'uuid' })
    executionId: string;

    @ApiProperty({ type: PullRequestAutomationExecutionDto })
    automationExecution: PullRequestAutomationExecutionDto;

    @ApiProperty({
        type: Object,
        isArray: true,
        description:
            'Timeline entries for code review automation (provider-specific).',
    })
    codeReviewTimeline: Record<string, unknown>[];

    @ApiProperty({
        type: Object,
        description: 'Enriched metadata from providers (shape varies).',
        additionalProperties: true,
    })
    enrichedData: Record<string, unknown>;

    @ApiProperty({
        type: Object,
        description:
            'Suggestion counters by category/severity (shape varies by config).',
        additionalProperties: true,
    })
    suggestionsCount: Record<string, unknown>;
}

export class PullRequestExecutionsPaginationDto {
    @ApiProperty()
    currentPage: number;

    @ApiProperty()
    totalPages: number;

    @ApiProperty()
    totalItems: number;

    // Distinct PRs matching the DB-level filters — the accurate "N pull
    // requests" for the header. Undefined on error/empty responses. Kept in the
    // API envelope so class-transformer doesn't strip it and the OpenAPI
    // contract matches the runtime `PaginationMetadata`.
    @ApiProperty({ required: false })
    distinctPrTotal?: number;

    @ApiProperty()
    itemsPerPage: number;

    @ApiProperty()
    hasNextPage: boolean;

    @ApiProperty()
    hasPreviousPage: boolean;
}

export class PullRequestExecutionsDataDto {
    @ApiProperty({ type: PullRequestExecutionDto, isArray: true })
    data: PullRequestExecutionDto[];

    @ApiProperty({ type: PullRequestExecutionsPaginationDto })
    pagination: PullRequestExecutionsPaginationDto;
}

export class PullRequestExecutionsResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: PullRequestExecutionsDataDto })
    data: PullRequestExecutionsDataDto;
}

export class PullRequestBackfillDataDto {
    @ApiProperty()
    success: boolean;

    @ApiProperty()
    message: string;

    @ApiProperty()
    repositoriesCount: number;
}

export class PullRequestBackfillResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: PullRequestBackfillDataDto })
    data: PullRequestBackfillDataDto;
}
