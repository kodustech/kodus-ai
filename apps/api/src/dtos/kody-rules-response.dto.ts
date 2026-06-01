import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiResponseBaseDto } from './api-response.dto';

export class KodyRulesLimitDto {
    @ApiProperty()
    total: number;
}

export class KodyRulesLimitResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: KodyRulesLimitDto })
    data: KodyRulesLimitDto;
}

export class KodyRulesSyncStatusDto {
    @ApiProperty()
    ideRulesSyncEnabledFirstTime: boolean;

    @ApiProperty()
    kodyRulesGeneratorEnabledFirstTime: boolean;
}

export class KodyRulesSyncStatusResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: KodyRulesSyncStatusDto })
    data: KodyRulesSyncStatusDto;
}

export class KodyRulesBucketDto {
    @ApiProperty()
    slug: string;

    @ApiProperty()
    title: string;

    @ApiProperty()
    description: string;

    @ApiProperty()
    rulesCount: number;
}

export class KodyRulesBucketsResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: KodyRulesBucketDto, isArray: true })
    data: KodyRulesBucketDto[];
}

export class KodyRulesExampleDto {
    @ApiProperty()
    snippet: string;

    @ApiProperty()
    isCorrect: boolean;
}

export class KodyRulesLibraryRuleDto {
    @ApiProperty()
    title: string;

    @ApiProperty()
    rule: string;

    @ApiProperty()
    why_is_this_important: string;

    @ApiProperty()
    severity: string;

    @ApiProperty()
    bad_example: string;

    @ApiProperty()
    good_example: string;

    @ApiProperty({ type: KodyRulesExampleDto, isArray: true })
    examples: KodyRulesExampleDto[];

    @ApiProperty()
    language: string;

    @ApiProperty({ format: 'uuid' })
    uuid: string;

    @ApiProperty({ type: String, isArray: true })
    buckets: string[];

    @ApiProperty()
    scope: string;

    @ApiProperty()
    plug_and_play: boolean;

    @ApiProperty()
    positiveCount: number;

    @ApiProperty()
    negativeCount: number;

    @ApiProperty({
        nullable: true,
        type: Object,
        description: 'Optional user feedback metadata (provider-specific).',
        additionalProperties: true,
    })
    userFeedback: Record<string, unknown> | null;
}

export class KodyRulesPaginationDto {
    @ApiProperty()
    currentPage: number;

    @ApiProperty()
    totalPages: number;

    @ApiProperty()
    totalItems: number;

    @ApiProperty()
    itemsPerPage: number;

    @ApiProperty()
    hasNextPage: boolean;

    @ApiProperty()
    hasPreviousPage: boolean;
}

export class KodyRulesLibraryDataDto {
    @ApiProperty({ type: KodyRulesLibraryRuleDto, isArray: true })
    data: KodyRulesLibraryRuleDto[];

    @ApiProperty({ type: KodyRulesPaginationDto })
    pagination: KodyRulesPaginationDto;
}

export class KodyRulesLibraryResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: KodyRulesLibraryDataDto })
    data: KodyRulesLibraryDataDto;
}

export class KodyRuleInheritanceDto {
    @ApiProperty()
    inheritable: boolean;

    @ApiProperty({ type: String, isArray: true })
    exclude: string[];

    @ApiProperty({ type: String, isArray: true })
    include: string[];
}

export class KodyRuleExternalReferenceDto {
    @ApiProperty()
    filePath: string;

    @ApiProperty({ nullable: true })
    description?: string;

    @ApiProperty({ nullable: true })
    repositoryName?: string;
}

export class KodyRuleSyncErrorDto {
    @ApiProperty()
    type: string;

    @ApiProperty({ nullable: true })
    message?: string;

    @ApiProperty({
        type: Object,
        description: 'Provider-specific error details.',
        additionalProperties: true,
    })
    details: Record<string, unknown>;
}

export class KodyRuleDto {
    @ApiProperty({ format: 'uuid' })
    uuid: string;

    @ApiProperty()
    title: string;

    @ApiProperty()
    rule: string;

    @ApiProperty({ nullable: true })
    path?: string | null;

    @ApiProperty({ nullable: true })
    sourcePath?: string | null;

    @ApiProperty({ nullable: true })
    sourceAnchor?: string | null;

    @ApiProperty()
    severity: string;

    @ApiProperty()
    status: string;

    @ApiProperty({ nullable: true })
    repositoryId?: string | null;

    @ApiProperty({ nullable: true })
    directoryId?: string | null;

    @ApiProperty({ type: KodyRulesExampleDto, isArray: true, nullable: true })
    examples?: KodyRulesExampleDto[] | null;

    @ApiProperty()
    origin: string;

    @ApiProperty()
    scope: string;

    @ApiProperty({ type: KodyRuleInheritanceDto })
    inheritance: KodyRuleInheritanceDto;

    @ApiProperty()
    createdAt: string;

    @ApiProperty()
    updatedAt: string;

    @ApiPropertyOptional()
    referenceProcessingStatus?: string | null;

    @ApiProperty({ type: KodyRuleExternalReferenceDto, isArray: true })
    externalReferences: KodyRuleExternalReferenceDto[];

    @ApiProperty({ type: KodyRuleSyncErrorDto, isArray: true })
    syncErrors: KodyRuleSyncErrorDto[];

    @ApiPropertyOptional({
        description:
            'True when the source file currently carries an `@kody-sync` marker — the per-file override that keeps the rule synced even with the repo `ideRulesSyncEnabled=false`. Surfaced so the UI can exclude such rules from the orphan chip and bulk pause/delete actions.',
    })
    pinnedSync?: boolean;
}

export class KodyRuleResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: KodyRuleDto })
    data: KodyRuleDto;
}

export class KodyRulesArrayResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: KodyRuleDto, isArray: true })
    data: KodyRuleDto[];
}

export class KodyRulesFindByOrgDataDto {
    @ApiProperty()
    _uuid: string;

    @ApiProperty()
    _organizationId: string;

    @ApiProperty({ type: KodyRuleDto, isArray: true })
    _rules: KodyRuleDto[];

    @ApiProperty()
    _createdAt: string;

    @ApiProperty()
    _updatedAt: string;
}

export class KodyRulesFindByOrgResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: KodyRulesFindByOrgDataDto })
    data: KodyRulesFindByOrgDataDto;
}

export class KodyRulesFastSyncDataDto {
    @ApiProperty({ type: KodyRuleDto, isArray: true })
    rules: KodyRuleDto[];

    @ApiProperty({ type: String, isArray: true })
    skippedFiles: string[];

    @ApiProperty({
        type: Object,
        isArray: true,
        description: 'Sync errors (provider-specific shape).',
    })
    errors: Record<string, unknown>[];
}

export class KodyRulesFastSyncResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: KodyRulesFastSyncDataDto })
    data: KodyRulesFastSyncDataDto;
}

export class KodyRulesInheritedDataDto {
    @ApiProperty({ type: KodyRuleDto, isArray: true })
    globalRules: KodyRuleDto[];

    @ApiProperty({ type: KodyRuleDto, isArray: true })
    repoRules: KodyRuleDto[];

    @ApiProperty({ type: KodyRuleDto, isArray: true })
    directoryRules: KodyRuleDto[];
}

export class KodyRulesInheritedResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: KodyRulesInheritedDataDto })
    data: KodyRulesInheritedDataDto;
}
