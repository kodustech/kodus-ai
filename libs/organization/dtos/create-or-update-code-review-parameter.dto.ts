import { Type } from 'class-transformer';
import {
    IsArray,
    IsBoolean,
    IsEnum,
    IsIn,
    IsNumber,
    IsObject,
    IsOptional,
    IsString,
    ValidateNested,
} from 'class-validator';

import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { OrganizationAndTeamDataDto } from '@libs/core/domain/dtos/organizationAndTeamData.dto';
import {
    BehaviourForExistingDescription,
    BehaviourForNewCommits,
    CodeReviewVersion,
    GroupingModeSuggestions,
    LimitationType,
    ReviewCadenceType,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { PullRequestMessageStatus } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class ReviewOptionsDto {
    @IsBoolean()
    @IsOptional()
    security?: boolean;

    @IsBoolean()
    @IsOptional()
    code_style?: boolean;

    @IsBoolean()
    @IsOptional()
    refactoring?: boolean;

    @IsBoolean()
    @IsOptional()
    error_handling?: boolean;

    @IsBoolean()
    @IsOptional()
    maintainability?: boolean;

    @IsBoolean()
    @IsOptional()
    potential_issues?: boolean;

    @IsBoolean()
    @IsOptional()
    documentation_and_comments?: boolean;

    @IsBoolean()
    @IsOptional()
    performance_and_optimization?: boolean;

    @IsBoolean()
    @IsOptional()
    kody_rules?: boolean;

    @IsBoolean()
    @IsOptional()
    breaking_changes?: boolean;

    @IsOptional()
    @IsBoolean()
    bug?: boolean;

    @IsOptional()
    @IsBoolean()
    performance?: boolean;

    @IsOptional()
    @IsBoolean()
    cross_file?: boolean;

    @IsOptional()
    @IsBoolean()
    business_logic?: boolean;
}

class SummaryConfigDto {
    @IsOptional()
    @IsBoolean()
    generatePRSummary?: boolean;

    @IsOptional()
    @IsString()
    customInstructions?: string;

    @IsOptional()
    @IsEnum(BehaviourForExistingDescription)
    @ApiPropertyOptional({
        enum: BehaviourForExistingDescription,
        enumName: 'BehaviourForExistingDescription',
    })
    behaviourForExistingDescription?: BehaviourForExistingDescription;

    @IsOptional()
    @IsEnum(BehaviourForNewCommits)
    @ApiPropertyOptional({
        enum: BehaviourForNewCommits,
        enumName: 'BehaviourForNewCommits',
    })
    behaviourForNewCommits?: BehaviourForNewCommits;
}

class SeverityLimitsDto {
    @IsNumber()
    @IsOptional()
    low?: number;

    @IsNumber()
    @IsOptional()
    medium?: number;

    @IsNumber()
    @IsOptional()
    high?: number;

    @IsNumber()
    @IsOptional()
    critical?: number;
}

class SuggestionControlConfigDto {
    @IsOptional()
    @IsEnum(GroupingModeSuggestions)
    @ApiPropertyOptional({
        enum: GroupingModeSuggestions,
        enumName: 'GroupingModeSuggestions',
    })
    groupingMode?: GroupingModeSuggestions;

    @IsOptional()
    @IsEnum(LimitationType)
    @ApiPropertyOptional({ enum: LimitationType, enumName: 'LimitationType' })
    limitationType?: LimitationType;

    @IsOptional()
    @IsNumber()
    maxSuggestions?: number;

    @IsOptional()
    @IsEnum(SeverityLevel)
    @ApiPropertyOptional({ enum: SeverityLevel, enumName: 'SeverityLevel' })
    severityLevelFilter?: SeverityLevel;

    @IsOptional()
    @IsBoolean()
    applyFiltersToKodyRules?: boolean;

    @IsOptional()
    @ValidateNested()
    @Type(() => SeverityLimitsDto)
    severityLimits?: SeverityLimitsDto;
}

class ReviewCadenceDto {
    @IsEnum(ReviewCadenceType)
    @IsOptional()
    @ApiPropertyOptional({
        enum: ReviewCadenceType,
        enumName: 'ReviewCadenceType',
    })
    type?: ReviewCadenceType;

    @IsOptional()
    @IsNumber()
    timeWindow?: number;

    @IsOptional()
    @IsNumber()
    pushesToTrigger?: number;
}

// -------------------- v2 Prompt Overrides DTOs (must be declared before usage) --------------------
class V2PromptOverridesSeverityFlagsDto {
    @IsOptional()
    @IsString()
    critical?: string;

    @IsOptional()
    @IsString()
    high?: string;

    @IsOptional()
    @IsString()
    medium?: string;

    @IsOptional()
    @IsString()
    low?: string;
}

class V2PromptOverridesSeverityDto {
    @IsOptional()
    @ValidateNested()
    @Type(() => V2PromptOverridesSeverityFlagsDto)
    flags?: V2PromptOverridesSeverityFlagsDto;
}

class V2PromptOverridesCategoriesDescriptionsDto {
    @IsOptional()
    @IsString()
    bug?: string;

    @IsOptional()
    @IsString()
    performance?: string;

    @IsOptional()
    @IsString()
    security?: string;
}

class V2PromptOverridesCategoriesDto {
    @IsOptional()
    @ValidateNested()
    @Type(() => V2PromptOverridesCategoriesDescriptionsDto)
    descriptions?: V2PromptOverridesCategoriesDescriptionsDto;
}

class V2PromptOverridesGenerationDto {
    @IsOptional()
    @IsString()
    main?: string;
}

class V2PromptOverridesLevelDto {
    @IsOptional()
    @IsString()
    critical?: string;

    @IsOptional()
    @IsString()
    issue?: string;

    @IsOptional()
    @IsString()
    warning?: string;
}

class V2PromptOverridesDto {
    @IsOptional()
    @ValidateNested()
    @Type(() => V2PromptOverridesCategoriesDto)
    categories?: V2PromptOverridesCategoriesDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => V2PromptOverridesSeverityDto)
    severity?: V2PromptOverridesSeverityDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => V2PromptOverridesLevelDto)
    level?: V2PromptOverridesLevelDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => V2PromptOverridesGenerationDto)
    generation?: V2PromptOverridesGenerationDto;
}

class CustomMessagesGlobalSettingsDto {
    @IsOptional()
    @IsBoolean()
    hideComments?: boolean;
}

class CustomMessagesStartReviewMessageDto {
    @IsOptional()
    @IsEnum(PullRequestMessageStatus)
    @ApiPropertyOptional({
        enum: PullRequestMessageStatus,
        enumName: 'PullRequestMessageStatus',
    })
    status?: PullRequestMessageStatus;

    @IsOptional()
    @IsString()
    content?: string;
}

class CustomMessagesEndReviewMessageDto {
    @IsOptional()
    @IsEnum(PullRequestMessageStatus)
    @ApiPropertyOptional({
        enum: PullRequestMessageStatus,
        enumName: 'PullRequestMessageStatus',
    })
    status?: PullRequestMessageStatus;

    @IsOptional()
    @IsString()
    content?: string;
}

class CustomMessagesErrorReviewMessageDto {
    @IsOptional()
    @IsEnum(PullRequestMessageStatus)
    @ApiPropertyOptional({
        enum: PullRequestMessageStatus,
        enumName: 'PullRequestMessageStatus',
    })
    status?: PullRequestMessageStatus;

    @IsOptional()
    @IsString()
    content?: string;
}

class CustomMessagesDto {
    @IsOptional()
    @ValidateNested()
    @Type(() => CustomMessagesGlobalSettingsDto)
    globalSettings?: CustomMessagesGlobalSettingsDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => CustomMessagesStartReviewMessageDto)
    startReviewMessage?: CustomMessagesStartReviewMessageDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => CustomMessagesEndReviewMessageDto)
    endReviewMessage?: CustomMessagesEndReviewMessageDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => CustomMessagesErrorReviewMessageDto)
    errorReviewMessage?: CustomMessagesErrorReviewMessageDto;
}

class KodyKnowledgeApprovalDto {
    @IsBoolean()
    enabled: boolean;
}

class CodeReviewConfigWithoutLLMProviderDto {
    @IsOptional()
    @IsString()
    id?: string;

    @IsOptional()
    @IsString()
    name?: string;

    @IsOptional()
    @IsString()
    path?: string;

    @IsOptional()
    @IsBoolean()
    isSelected?: boolean;

    @IsOptional()
    @IsArray()
    ignorePaths?: string[];

    @IsOptional()
    @ValidateNested()
    @Type(() => ReviewOptionsDto)
    reviewOptions?: ReviewOptionsDto;

    @IsOptional()
    @IsArray()
    ignoredTitleKeywords?: string[];

    @IsOptional()
    @IsArray()
    baseBranches?: string[];

    @IsOptional()
    @IsBoolean()
    automatedReviewActive?: boolean;

    @IsOptional()
    @IsBoolean()
    showStatusFeedback?: boolean;

    @IsOptional()
    @ValidateNested()
    @Type(() => SummaryConfigDto)
    summary?: SummaryConfigDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => SuggestionControlConfigDto)
    suggestionControl?: SuggestionControlConfigDto;

    @IsOptional()
    @IsBoolean()
    pullRequestApprovalActive?: boolean;

    @IsOptional()
    @IsBoolean()
    kodusConfigFileOverridesWebPreferences?: boolean;

    @IsOptional()
    @IsBoolean()
    isRequestChangesActive?: boolean;

    @IsOptional()
    @IsBoolean()
    ideRulesSyncEnabled?: boolean;

    /**
     * Only consulted when `ideRulesSyncEnabled` transitions from `true` to
     * `false`. Picks what happens to imported rules. See
     * `IdeSyncDisableAction` for semantics. Defaults to `'keep'` (least
     * destructive) when callers omit it — historically this transition
     * silently deleted rules, which surprised users.
     */
    @IsOptional()
    @IsIn(['keep', 'pause', 'delete'])
    ideSyncDisableAction?: 'keep' | 'pause' | 'delete';

    @IsOptional()
    @IsBoolean()
    kodyRulesGeneratorEnabled?: boolean;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    kodyLearningExcludedReviewers?: string[];

    @IsOptional()
    @ValidateNested()
    @Type(() => KodyKnowledgeApprovalDto)
    kodyKnowledgeApproval?: KodyKnowledgeApprovalDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => ReviewCadenceDto)
    reviewCadence?: ReviewCadenceDto;

    @IsOptional()
    @IsBoolean()
    runOnDraft?: boolean;

    @IsOptional()
    @IsEnum(CodeReviewVersion)
    @ApiPropertyOptional({
        enum: CodeReviewVersion,
        enumName: 'CodeReviewVersion',
    })
    codeReviewVersion?: CodeReviewVersion;

    @IsOptional()
    @ValidateNested()
    @Type(() => V2PromptOverridesDto)
    v2PromptOverrides?: V2PromptOverridesDto;

    @IsOptional()
    @IsString()
    contextReferenceId?: string;

    @IsOptional()
    @IsString()
    contextRequirementsHash?: string;

    @IsOptional()
    @ValidateNested()
    @Type(() => CustomMessagesDto)
    customMessages?: CustomMessagesDto;

    @IsOptional()
    @IsBoolean()
    enableCommittableSuggestions?: boolean;

    /**
     * BYOK main-model override for code reviews. Empty string '' means
     * "inherit" (directory -> repository -> the BYOK-settings main model).
     */
    @IsOptional()
    @IsString()
    byokModel?: string;
}

export class CreateOrUpdateCodeReviewParameterDto {
    @IsObject()
    @ApiProperty({
        type: OrganizationAndTeamDataDto,
        example: {
            teamId: 'c33ef663-70e7-4f43-9605-0bbef979b8e0',
        },
    })
    organizationAndTeamData: OrganizationAndTeamDataDto;

    @ValidateNested()
    @Type(() => CodeReviewConfigWithoutLLMProviderDto)
    @ApiProperty({
        type: CodeReviewConfigWithoutLLMProviderDto,
        example: {
            reviewCadence: { type: 'every_pr' },
            reviewOptions: { security: true, error_handling: true },
        },
    })
    configValue: CodeReviewConfigWithoutLLMProviderDto;

    @IsString()
    @IsOptional()
    @ApiPropertyOptional({ example: '1135722979' })
    repositoryId: string;

    @IsString()
    @IsOptional()
    @ApiPropertyOptional({ example: 'src/services' })
    directoryId?: string;

    @IsString()
    @IsOptional()
    @ApiPropertyOptional({ example: 'src/services' })
    directoryPath?: string;

    @IsArray()
    @IsString({ each: true })
    @IsOptional()
    @ApiPropertyOptional({ example: ['/src/services', '/src/controllers'] })
    directoryPaths?: string[];
}
