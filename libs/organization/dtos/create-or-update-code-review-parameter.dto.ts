import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsBoolean,
    IsByteLength,
    IsEnum,
    IsIn,
    IsInt,
    IsNotEmpty,
    IsNumber,
    IsObject,
    IsOptional,
    IsPositive,
    IsString,
    Matches,
    MaxLength,
    ValidateBy,
    ValidateNested,
    ValidationOptions,
    ValidateIf,
} from 'class-validator';

import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { OrganizationAndTeamDataDto } from '@libs/core/domain/dtos/organizationAndTeamData.dto';
import {
    BehaviourForExistingDescription,
    BehaviourForNewCommits,
    CLI_SECRET_ENV_PATTERN,
    CodeReviewVersion,
    CUSTOM_AGENT_LIMITS,
    GroupingModeSuggestions,
    KNOWLEDGE_MAIN_REVIEW_TARGET,
    KnowledgeItem,
    customAgentSlugClashMessage,
    firstDuplicate,
    LimitationType,
    ReviewCadenceType,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { cliInstallProblem } from '@libs/core/infrastructure/config/types/general/cli-install';
import {
    cliBinaryExposureProblem,
    cliPrefixExposureProblem,
} from '@libs/core/infrastructure/config/types/general/cli-env-guard';
import {
    ConfigLevel,
    PullRequestMessageStatus,
} from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';
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

/**
 * Cross-repo context (#1576): one linked sibling repository the agent may
 * consult during review of the declaring repo.
 */
class LinkedRepositoryDto {
    @IsString()
    @ApiProperty({
        example: 'org/backend-api',
        description: 'Full repository name of a repo connected to this org.',
    })
    repository: string;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional({
        example: 'REST API this frontend consumes',
        description: 'Free-text hint for the agent about this link.',
    })
    instructions?: string;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional({
        example: 'main',
        description:
            'Optional ref pin. When omitted, cascade uses the PR head branch if it exists, otherwise the default branch.',
    })
    ref?: string;
}

/**
 * Per-tool switch for the deterministic scanners. Named explicitly rather than
 * a Record, because `forbidNonWhitelisted` is on globally: an unlisted key is
 * a rejected request, not a silently ignored one.
 */
class DeterministicEvidenceToolsDto {
    @IsOptional()
    @IsBoolean()
    @ApiPropertyOptional()
    secrets?: boolean;

    @IsOptional()
    @IsBoolean()
    @ApiPropertyOptional()
    dependencies?: boolean;
}

class DeterministicEvidenceDto {
    /** Read the checks the repository's own CI already ran on the commit. */
    @IsOptional()
    @IsBoolean()
    ciChecks?: boolean;

    @IsOptional()
    @ValidateNested()
    @Type(() => DeterministicEvidenceToolsDto)
    tools?: DeterministicEvidenceToolsDto;
}

/**
 * A secret is write-only: the screen sends `value` when the user types one,
 * or echoes back the masked `ciphertext` it read to keep the stored value.
 * The save use case encrypts `value` and never stores it.
 */
class CliToolSecretDto {
    @Matches(CLI_SECRET_ENV_PATTERN)
    env: string;

    @ValidateIf((secret: CliToolSecretDto) => !secret.value)
    @IsString()
    @IsNotEmpty()
    // Absent when `value` is sent; the save fills it before storing.
    ciphertext: string;

    @IsOptional()
    @IsString()
    value?: string;
}

const hasSecrets = (cli: { secrets?: unknown } | undefined) =>
    Array.isArray(cli?.secrets) && cli.secrets.length > 0;

class CliToolConfigDto {
    @IsString()
    name: string;

    /** One package-manager install whose every package pins an exact
     *  version (`@1.2.3`, `==1.2.3`) or a sha256 digest. */
    @IsString()
    @ValidateBy({
        name: 'pinnedInstall',
        validator: {
            validate: (install: unknown) => cliInstallProblem(install) === null,
            defaultMessage: (args) =>
                `install ${cliInstallProblem(args?.value) ?? 'is invalid'}`,
        },
    })
    install: string;

    /** Not a shell or interpreter when the CLI has secrets: those can print
     *  their env whatever the prefixes say. */
    @IsString()
    @ValidateBy({
        name: 'binaryKeepsSecrets',
        validator: {
            validate: (binary: unknown, args) =>
                !hasSecrets(args?.object as CliToolConfigDto) ||
                cliBinaryExposureProblem(String(binary ?? '')) === null,
            defaultMessage: (args) =>
                `binary ${cliBinaryExposureProblem(String(args?.value ?? ''))}`,
        },
    })
    binary: string;

    @IsArray()
    @ArrayMinSize(1)
    @IsString({ each: true })
    @IsNotEmpty({ each: true })
    // With secrets, no prefix may list the env or print a stored token.
    @ValidateBy({
        name: 'prefixKeepsSecrets',
        validator: {
            validate: (prefixes: unknown, args) =>
                !hasSecrets(args?.object as CliToolConfigDto) ||
                !Array.isArray(prefixes) ||
                prefixes.every(
                    (prefix) =>
                        cliPrefixExposureProblem(String(prefix)) === null,
                ),
            defaultMessage: (args) => {
                const problem = (Array.isArray(args?.value) ? args.value : [])
                    .map((prefix: unknown) =>
                        cliPrefixExposureProblem(String(prefix)),
                    )
                    .find(Boolean);
                return `allowedPrefixes cannot be used with secrets: ${problem ?? 'a prefix exposes the environment'}`;
            },
        },
    })
    // The runner ignores the binary in a prefix, so one that is only the
    // binary would match no call at all.
    @ValidateBy({
        name: 'prefixNamesMoreThanTheBinary',
        validator: {
            validate: (prefixes: unknown, args) => {
                const cli = args?.object as CliToolConfigDto;
                return (
                    !Array.isArray(prefixes) ||
                    prefixes.every((prefix) => {
                        const tokens = String(prefix).trim().split(/\s+/);
                        return !(
                            tokens.length === 1 &&
                            (tokens[0] === cli?.binary ||
                                tokens[0] === cli?.name)
                        );
                    })
                );
            },
            defaultMessage: () =>
                'allowedPrefixes must name a subcommand or flag after the binary',
        },
    })
    allowedPrefixes: string[];

    @IsString()
    usage: string;

    @IsBoolean()
    runsProjectCode: boolean;

    /** Never set when `runsProjectCode`: project code must not see secrets. */
    @IsOptional()
    @IsArray()
    @ValidateBy({
        name: 'noSecretsWhenRunningProjectCode',
        validator: {
            validate: (secrets: unknown, args) =>
                !(args?.object as CliToolConfigDto)?.runsProjectCode ||
                !Array.isArray(secrets) ||
                secrets.length === 0,
            defaultMessage: () =>
                'secrets are not allowed on a CLI that runs project code',
        },
    })
    @ValidateNested({ each: true })
    @Type(() => CliToolSecretDto)
    secrets?: CliToolSecretDto[];

    @IsArray()
    @IsString({ each: true })
    allowedDomains: string[];

    @IsOptional()
    @IsInt()
    @IsPositive()
    timeoutSec?: number;
}

class CustomAgentMcpToolsDto {
    @IsString()
    integrationId: string;

    @IsArray()
    @IsString({ each: true })
    tools: string[];
}

class CustomAgentToolsDto {
    @IsOptional()
    @IsString()
    @IsByteLength(0, CUSTOM_AGENT_LIMITS.maxAstGrepRuleBytes, {
        message: `astGrepConfig allows at most ${CUSTOM_AGENT_LIMITS.maxAstGrepRuleBytes} bytes`,
    })
    astGrepConfig?: string;

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CustomAgentMcpToolsDto)
    mcp?: CustomAgentMcpToolsDto[];

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(CUSTOM_AGENT_LIMITS.maxCliTools)
    @ValidateBy({
        name: 'uniqueCliNames',
        validator: {
            validate: (clis: unknown) =>
                !Array.isArray(clis) ||
                firstDuplicate(clis.map((c) => c?.name)) === undefined,
            defaultMessage: () => 'CLI names must be unique within an agent',
        },
    })
    @ValidateNested({ each: true })
    @Type(() => CliToolConfigDto)
    cli?: CliToolConfigDto[];
}

class CustomAgentScopeDto {
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    include?: string[];

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    exclude?: string[];
}

class CustomAgentModelsDto {
    @IsOptional()
    @IsString()
    run?: string;
}

class CustomAgentTagDto {
    @IsString()
    color: string;
}

class CustomAgentPresentationDto {
    @ValidateNested()
    @Type(() => CustomAgentTagDto)
    tag: CustomAgentTagDto;

    @IsIn(['inline', 'single-comment'])
    format: 'inline' | 'single-comment';

    @IsOptional()
    @IsEnum(SeverityLevel)
    minSeverity?: SeverityLevel;

    @IsOptional()
    @IsInt()
    @IsPositive()
    maxComments?: number;

    @IsIn(['when-confident', 'never'])
    suggestedFix: 'when-confident' | 'never';

    @IsOptional()
    @IsString()
    @MaxLength(CUSTOM_AGENT_LIMITS.maxWritingLength)
    writing?: string;
}

class CustomAgentConfigDto {
    @IsString()
    @IsNotEmpty()
    id: string;

    @IsString()
    @IsNotEmpty()
    name: string;

    @IsBoolean()
    enabled: boolean;

    @IsString()
    @MaxLength(CUSTOM_AGENT_LIMITS.maxInstructionsLength)
    instructions: string;

    @ValidateNested()
    @Type(() => CustomAgentScopeDto)
    scope: CustomAgentScopeDto;

    @ValidateNested()
    @Type(() => CustomAgentToolsDto)
    tools: CustomAgentToolsDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => CustomAgentModelsDto)
    models?: CustomAgentModelsDto;

    @ValidateNested()
    @Type(() => CustomAgentPresentationDto)
    presentation: CustomAgentPresentationDto;
    /** Where the entry was declared; set by the cascade, echoed back on save. */
    @IsOptional()
    @IsEnum(ConfigLevel)
    level?: ConfigLevel;
}

const isKnowledgeLinkTarget = (value: unknown): boolean =>
    value === KNOWLEDGE_MAIN_REVIEW_TARGET ||
    (typeof value === 'object' &&
        value !== null &&
        Object.keys(value).length === 1 &&
        typeof (value as { agentId?: unknown }).agentId === 'string' &&
        (value as { agentId: string }).agentId.length > 0);

const knowledgeTargetKey = (target: KnowledgeItem['linkedTo'][number]) =>
    typeof target === 'string' ? target : `agent:${target.agentId}`;

/**
 * Skills and docs are capped per target (the main review or one agent),
 * not per config: twelve docs split across two agents is fine, eleven on
 * one agent is not.
 */
function KnowledgeWithinTargetLimits(validationOptions?: ValidationOptions) {
    return ValidateBy(
        {
            name: 'knowledgeWithinTargetLimits',
            validator: {
                validate: (items: unknown) => {
                    if (!Array.isArray(items)) return true;
                    const counts = new Map<string, number>();
                    for (const item of items as KnowledgeItem[]) {
                        if (!Array.isArray(item?.linkedTo)) continue;
                        for (const target of item.linkedTo) {
                            if (!isKnowledgeLinkTarget(target)) continue;
                            const key = `${item.kind}|${knowledgeTargetKey(target)}`;
                            counts.set(key, (counts.get(key) ?? 0) + 1);
                        }
                    }
                    for (const [key, count] of counts) {
                        const limit = key.startsWith('skill|')
                            ? CUSTOM_AGENT_LIMITS.maxSkills
                            : CUSTOM_AGENT_LIMITS.maxDocs;
                        if (count > limit) return false;
                    }
                    return true;
                },
                defaultMessage: () =>
                    `knowledge allows at most ${CUSTOM_AGENT_LIMITS.maxSkills} skills and ${CUSTOM_AGENT_LIMITS.maxDocs} docs per target`,
            },
        },
        validationOptions,
    );
}

class KnowledgeItemDto {
    @IsString()
    path: string;

    @IsIn(['skill', 'doc'])
    kind: 'skill' | 'doc';

    @IsArray()
    @ValidateBy(
        {
            name: 'isKnowledgeLinkTarget',
            validator: {
                validate: isKnowledgeLinkTarget,
                defaultMessage: () =>
                    `each linkedTo entry must be '${KNOWLEDGE_MAIN_REVIEW_TARGET}' or { agentId }`,
            },
        },
        { each: true },
    )
    linkedTo: KnowledgeItem['linkedTo'];
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
    @IsBoolean()
    kodyRulesAutoPauseEnabled?: boolean;

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
    @ValidateNested()
    @Type(() => DeterministicEvidenceDto)
    @ApiPropertyOptional({ type: DeterministicEvidenceDto })
    deterministicEvidence?: DeterministicEvidenceDto;

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
     *
     * Legacy NAME-based override; kept for the transition window (D-05).
     */
    @IsOptional()
    @IsString()
    byokModel?: string;

    /**
     * Id-based BYOK model override (Phase 4). References a v2 `models[]` entry
     * by its stable id. Additive alongside `byokModel`; the routing resolver
     * reads this first and falls back to the legacy NAME during the window.
     * Empty/absent means "inherit".
     */
    @IsOptional()
    @IsString()
    byokModelId?: string;

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => LinkedRepositoryDto)
    @ApiPropertyOptional({
        type: [LinkedRepositoryDto],
        description:
            'Sibling repositories Kody may grep/read during review for cross-boundary checks.',
    })
    linkedRepositories?: LinkedRepositoryDto[];

    @IsOptional()
    @IsArray()
    @ValidateBy({
        name: 'uniqueCustomAgentIds',
        validator: {
            validate: (agents: unknown) =>
                !Array.isArray(agents) ||
                firstDuplicate(agents.map((a) => a?.id)) === undefined,
            defaultMessage: () => 'customAgents ids must be unique',
        },
    })
    @ValidateBy({
        name: 'uniqueCustomAgentSlugs',
        validator: {
            validate: (agents: unknown) =>
                !Array.isArray(agents) ||
                customAgentSlugClashMessage(agents) === undefined,
            defaultMessage: (args) =>
                (Array.isArray(args?.value)
                    ? customAgentSlugClashMessage(args.value)
                    : undefined) ?? 'customAgents names must be unique',
        },
    })
    @ValidateNested({ each: true })
    @Type(() => CustomAgentConfigDto)
    @ApiPropertyOptional({
        type: [CustomAgentConfigDto],
        description: 'Team-defined review agents that run next to Kody.',
    })
    customAgents?: CustomAgentConfigDto[];

    @IsOptional()
    @IsArray()
    @KnowledgeWithinTargetLimits()
    // Links to unknown agents are refused by the save, which knows the agents
    // a directory inherits from its repository.
    @ValidateNested({ each: true })
    @Type(() => KnowledgeItemDto)
    @ApiPropertyOptional({
        type: [KnowledgeItemDto],
        description:
            'Skills and docs in the repository, linked to the main review or to agents.',
    })
    knowledge?: KnowledgeItemDto[];
}

/**
 * The custom agents and knowledge revisions the screen loaded (from the
 * code review config it read). A save of either list is refused with 409
 * when the stored list changed since.
 */
export class ExpectedCustomAgentsRevisionsDto {
    @IsString()
    @IsOptional()
    @MaxLength(64)
    customAgents?: string;

    @IsString()
    @IsOptional()
    @MaxLength(64)
    knowledge?: string;
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

    @ValidateNested()
    @Type(() => ExpectedCustomAgentsRevisionsDto)
    @IsOptional()
    @ApiPropertyOptional({
        type: ExpectedCustomAgentsRevisionsDto,
        description:
            'Revisions of the custom agents and knowledge the caller loaded. A save of either list made from an older revision is refused with 409.',
    })
    expectedRevisions?: ExpectedCustomAgentsRevisionsDto;
}
