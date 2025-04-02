import {
    IsObject,
    IsString,
    IsOptional,
    IsArray,
    IsBoolean,
    ValidateNested,
    IsNumber,
    IsEnum,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrganizationAndTeamDataDto } from './organizationAndTeamData.dto';
import {
    BehaviourForExistingDescription,
    GroupingModeSuggestions,
    LimitationType,
} from '@/config/types/general/codeReview.type';
import { SeverityLevel } from '@/shared/utils/enums/severityLevel.enum';

class ReviewOptionsDto {
    @IsBoolean()
    security: boolean;

    @IsBoolean()
    code_style: boolean;

    @IsBoolean()
    refactoring: boolean;

    @IsBoolean()
    error_handling: boolean;

    @IsBoolean()
    maintainability: boolean;

    @IsBoolean()
    potential_issues: boolean;

    @IsBoolean()
    documentation_and_comments: boolean;

    @IsBoolean()
    performance_and_optimization: boolean;

    @IsBoolean()
    kody_rules: boolean;

    @IsBoolean()
    breaking_changes: boolean;
}

class SummaryConfigDto {
    @IsOptional()
    @IsBoolean()
    generatePRSummary?: boolean;

    @IsOptional()
    @IsString()
    customInstructions?: string;

    @IsOptional()
    behaviourForExistingDescription?: BehaviourForExistingDescription;
}

class SuggestionControlConfigDto {
    @IsOptional()
    @IsEnum(GroupingModeSuggestions)
    groupingMode?: GroupingModeSuggestions;

    @IsOptional()
    @IsEnum(LimitationType)
    limitationType?: LimitationType;

    @IsOptional()
    @IsNumber()
    maxSuggestions?: number;

    @IsOptional()
    @IsEnum(SeverityLevel)
    severityLevelFilter?: SeverityLevel;
}

class PathInstructionDto {
    @IsOptional()
    @IsString()
    path?: string;

    @IsOptional()
    @IsString()
    instructions?: string;
}

class CodeReviewConfigWithoutLLMProviderDto {
    @IsOptional()
    @IsString()
    id?: string;

    @IsOptional()
    @IsString()
    name?: string;

    @IsOptional()
    @IsBoolean()
    isSelected?: boolean;

    @IsOptional()
    @IsArray()
    ignorePaths?: string[] = [];

    @IsOptional()
    @ValidateNested()
    @Type(() => ReviewOptionsDto)
    reviewOptions?: ReviewOptionsDto;

    @IsOptional()
    @IsArray()
    ignoredTitleKeywords?: string[] = [];

    @IsOptional()
    @IsArray()
    baseBranches?: string[] = [];

    @IsOptional()
    @IsBoolean()
    automatedReviewActive?: boolean;

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
    kodyRulesGeneratorEnabled?: boolean;
}

export class CreateOrUpdateCodeReviewParameterDto {
    @IsObject()
    organizationAndTeamData: OrganizationAndTeamDataDto;

    @ValidateNested()
    @Type(() => CodeReviewConfigWithoutLLMProviderDto)
    configValue: CodeReviewConfigWithoutLLMProviderDto;

    @IsString()
    @IsOptional()
    repositoryId?: string;
}
