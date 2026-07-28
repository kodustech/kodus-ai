import { ApiProperty } from '@nestjs/swagger';
import { ApiResponseBaseDto } from './api-response.dto';

export class CodeReviewAutomationLabelDto {
    @ApiProperty()
    type: string;

    @ApiProperty()
    name: string;

    @ApiProperty()
    description: string;
}

export class CodeReviewAutomationLabelsDataDto {
    @ApiProperty({ type: CodeReviewAutomationLabelDto, isArray: true })
    labels: CodeReviewAutomationLabelDto[];
}

export class CodeReviewAutomationLabelsResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: CodeReviewAutomationLabelsDataDto })
    data: CodeReviewAutomationLabelsDataDto;
}

export class CodeReviewCadenceDto {
    @ApiProperty()
    type: string;

    @ApiProperty()
    timeWindow: number;

    @ApiProperty()
    pushesToTrigger: number;
}

export class CodeReviewOptionsDto {
    @ApiProperty()
    bug: boolean;

    @ApiProperty()
    performance: boolean;

    @ApiProperty()
    security: boolean;

    @ApiProperty()
    cross_file: boolean;

    @ApiProperty({ required: false })
    business_logic?: boolean;
}

export class SeverityLimitsDto {
    @ApiProperty()
    low: number;

    @ApiProperty()
    medium: number;

    @ApiProperty()
    high: number;

    @ApiProperty()
    critical: number;
}

export class SuggestionControlDto {
    @ApiProperty()
    groupingMode: string;

    @ApiProperty()
    applyFiltersToKodyRules: boolean;

    @ApiProperty()
    limitationType: string;

    @ApiProperty()
    maxSuggestions: number;

    @ApiProperty()
    severityLevelFilter: string;

    @ApiProperty({ type: SeverityLimitsDto })
    severityLimits: SeverityLimitsDto;
}

export class ReviewSummaryDto {
    @ApiProperty()
    generatePRSummary: boolean;

    @ApiProperty()
    behaviourForNewCommits: string;

    @ApiProperty()
    behaviourForExistingDescription: string;

    @ApiProperty()
    customInstructions: string;
}

export class CustomMessageConfigDto {
    @ApiProperty()
    hideComments: boolean;

    @ApiProperty()
    suggestionCopyPrompt: boolean;
}

export class CustomMessageTemplateDto {
    @ApiProperty()
    status: string;

    @ApiProperty()
    content: string;
}

export class CustomMessagesDto {
    @ApiProperty({ type: CustomMessageConfigDto })
    globalSettings: CustomMessageConfigDto;

    @ApiProperty({ type: CustomMessageTemplateDto })
    startReviewMessage: CustomMessageTemplateDto;

    @ApiProperty({ type: CustomMessageTemplateDto })
    endReviewMessage: CustomMessageTemplateDto;
}

export class CodeReviewConfigDataDto {
    @ApiProperty()
    automatedReviewActive: boolean;

    @ApiProperty()
    showStatusFeedback: boolean;

    @ApiProperty()
    kodusConfigFileOverridesWebPreferences: boolean;

    @ApiProperty({ type: CodeReviewCadenceDto })
    reviewCadence: CodeReviewCadenceDto;

    @ApiProperty()
    pullRequestApprovalActive: boolean;

    @ApiProperty()
    isRequestChangesActive: boolean;

    @ApiProperty()
    runOnDraft: boolean;

    @ApiProperty({ type: String, isArray: true })
    ignorePaths: string[];

    @ApiProperty({ type: String, isArray: true })
    ignoredTitleKeywords: string[];

    @ApiProperty({ type: String, isArray: true })
    baseBranches: string[];

    @ApiProperty()
    enableCommittableSuggestions: boolean;

    @ApiProperty()
    codeReviewVersion: string;

    @ApiProperty({ type: CodeReviewOptionsDto })
    reviewOptions: CodeReviewOptionsDto;

    @ApiProperty({ type: SuggestionControlDto })
    suggestionControl: SuggestionControlDto;

    @ApiProperty({ type: ReviewSummaryDto })
    summary: ReviewSummaryDto;

    @ApiProperty()
    ideRulesSyncEnabled: boolean;

    @ApiProperty()
    kodyRulesGeneratorEnabled: boolean;

    @ApiProperty({ type: [String], required: false })
    kodyLearningExcludedReviewers?: string[];

    @ApiProperty({ type: CustomMessagesDto })
    customMessages: CustomMessagesDto;

    @ApiProperty({
        type: Object,
        description: 'Prompt override map (key/value by prompt identifier).',
        additionalProperties: true,
    })
    v2PromptOverrides: Record<string, unknown>;
}

export class CodeReviewConfigResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: CodeReviewConfigDataDto })
    data: CodeReviewConfigDataDto;
}

export class ParametersStoredDto {
    @ApiProperty({ format: 'uuid' })
    _uuid: string;

    @ApiProperty()
    _active: boolean;

    @ApiProperty()
    _configKey: string;

    @ApiProperty({
        type: Object,
        description: 'Parameter value (schema varies by config key).',
        additionalProperties: true,
    })
    _configValue: Record<string, unknown>;

    @ApiProperty()
    _createdAt: string;

    @ApiProperty()
    _updatedAt: string;

    @ApiProperty()
    _version: number;
}

export class ParametersStoredResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: ParametersStoredDto })
    data: ParametersStoredDto;
}

export class CodeReviewParameterDto {
    @ApiProperty({ format: 'uuid' })
    uuid: string;

    @ApiProperty()
    configKey: string;

    @ApiProperty({
        type: Object,
        description: 'Parameter value (schema varies by config key).',
        additionalProperties: true,
    })
    configValue: Record<string, unknown>;

    @ApiProperty()
    isSelected: boolean;

    @ApiProperty({
        type: Object,
        isArray: true,
        description: 'Repository bindings for this parameter.',
    })
    repositories: Record<string, unknown>[];
}

export class CodeReviewParameterResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: CodeReviewParameterDto })
    data: CodeReviewParameterDto;
}
