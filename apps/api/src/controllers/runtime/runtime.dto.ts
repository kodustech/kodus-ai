import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    ArrayMaxSize,
    ArrayMinSize,
    ArrayUnique,
    IsArray,
    IsBoolean,
    IsIn,
    IsInt,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsPositive,
    IsString,
    Max,
    MaxLength,
    Min,
    ValidateIf,
    IsObject,
    ValidateBy,
} from 'class-validator';

import { EGRESS_APPROVAL_MODES, EGRESS_WHO_MAY_ADD, type EgressApprovalMode, type EgressWhoMayAdd } from '@libs/runtime/contracts/egress';
import { FORK_PULL_REQUEST_POLICIES, type ForkPullRequestPolicy, PARTLY_TESTED_CHECKS, type PartlyTestedCheck } from '@libs/runtime/contracts/enums';
import { MACHINE_SIZE_PRESETS, type MachineSizePreset } from '@libs/runtime/contracts/machine-size';
import { MAX_USD_PER_HOST_HOUR } from '@libs/runtime/api/domain/run-cost';

// Request shapes of the Kody Runtime routes. The global ValidationPipe
// (whitelist, forbidNonWhitelisted) refuses unknown fields and wrong types
// before a use case runs; the use cases keep their own checks for the
// domain rules (denylist, repo ownership, rule grammar).

const ID_MAX = 128;

export class ApproveEgressHostDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(253)
    @ApiProperty({
        example: 'registry.npmjs.org',
        description: 'One host; the Kodus denylist is refused.',
    })
    host: string;

    @IsOptional()
    @IsIn(EGRESS_APPROVAL_MODES)
    @ApiPropertyOptional({ enum: EGRESS_APPROVAL_MODES, description: 'inspected (default): only GET/HEAD under pathPrefixes leave the cell; passthrough: full access.' })
    mode?: EgressApprovalMode;

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(16)
    @IsString({ each: true })
    @MaxLength(256, { each: true })
    @ApiPropertyOptional({ type: [String], example: ['/xlsx-'], description: "For mode inspected: the path prefixes a read may name ('/' when none)." })
    pathPrefixes?: string[];

    @IsOptional()
    @IsIn(['blocker', 'settings'])
    @ApiPropertyOptional({ enum: ['blocker', 'settings'] })
    source?: 'blocker' | 'settings';

    @IsOptional()
    @IsString()
    @MaxLength(256)
    @ApiPropertyOptional({ description: 'The blocker signature with its setup or Run id, for the audit.' })
    sourceRef?: string;

    @IsOptional()
    @IsString()
    @MaxLength(500)
    @ApiPropertyOptional()
    reason?: string;
}

export class RevokeEgressHostDto {
    @IsOptional()
    @IsString()
    @MaxLength(500)
    @ApiPropertyOptional()
    reason?: string;
}

export class OrgEgressSettingsDto {
    @IsOptional()
    @IsBoolean()
    @ApiPropertyOptional({ description: 'The Kodus recommended list on (default) or off (D2): off, installs from registries fail.' })
    recommendedEnabled?: boolean;

    @IsOptional()
    @IsIn(EGRESS_WHO_MAY_ADD)
    @ApiPropertyOptional({ enum: EGRESS_WHO_MAY_ADD, description: 'Who may add a host to an environment (D3).' })
    whoMayAdd?: EgressWhoMayAdd;
}

/** The org admin's stop: `org` only. The global stop is an ops route. */
export class OrgRuntimeStopDto {
    @IsIn(['org'])
    @ApiProperty({ enum: ['org'], example: 'org' })
    scope: 'org';
}

export class CreateCellRegistrationTokenDto {
    @IsIn(['hybrid', 'self_hosted'])
    @ApiProperty({ enum: ['hybrid', 'self_hosted'] })
    topology: 'hybrid' | 'self_hosted';
}

export class RevokeCellDto {
    @IsOptional()
    @IsString()
    @MaxLength(500)
    @ApiPropertyOptional({ maxLength: 500 })
    reason?: string;
}

export class CreateRuntimeEnvironmentDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(ID_MAX)
    @ApiProperty({ example: '1135722979' })
    repositoryId: string;
}

export class UpdateEnvironmentSettingsDto {
    @IsOptional()
    @IsBoolean()
    @ApiPropertyOptional({
        description:
            'Keep a failed default-branch setup alive until its hard TTL, for the dev agent (never a PR).',
    })
    diagnosticHold?: boolean;

    @IsOptional()
    @IsIn([...MACHINE_SIZE_PRESETS])
    @ApiPropertyOptional({
        nullable: true,
        enum: MACHINE_SIZE_PRESETS,
        example: 'medium',
        description:
            "The memory and CPUs of the environment's builds and services: small 4 GB / 2 CPUs, medium 8 GB / 4 CPUs, large 16 GB / 8 CPUs; null for the cell's default. Applies from the next setup.",
    })
    machineSize?: MachineSizePreset | null;

    @IsOptional()
    @IsIn([...FORK_PULL_REQUEST_POLICIES])
    @ApiPropertyOptional({
        enum: FORK_PULL_REQUEST_POLICIES,
        example: 'require_approval',
        description:
            'What a pull request from a fork does: skip starts no Run, require_approval waits for a maintainer with write access, run starts it at once (only in an environment of one repository: with several, run reads as require_approval, shown as effectiveForkPullRequests). Fork Runs get a smaller budget and no warm machine.',
    })
    forkPullRequests?: ForkPullRequestPolicy;

    @IsOptional()
    @IsInt()
    @Min(0)
    @ApiPropertyOptional({
        nullable: true,
        example: 2,
        description:
            "Warm pool machines kept ready for this environment, up to the plan's ceiling; null for the plan's default, 0 for none.",
    })
    poolSize?: number | null;

    // Checked field by field in the use case (domain/pool.ts parsePoolPolicy): a schedule, a pull request warm-up, a budget.
    @IsOptional()
    @IsObject()
    @ApiPropertyOptional({
        nullable: true,
        example: {
            schedule: {
                timezone: 'America/Sao_Paulo',
                days: ['mon', 'tue', 'wed', 'thu', 'fri'],
                start: '08:00',
                end: '19:00',
            },
            onPullRequest: { idleMinutes: 60 },
            monthlyBudgetUsd: 200,
        },
        description:
            'When the machines are kept ready; null keeps them ready all the time.',
    })
    poolPolicy?: Record<string, unknown> | null;

    @IsOptional()
    @IsIn(['none', 'run'])
    @ApiPropertyOptional({
        enum: ['none', 'run'],
        example: 'none',
        description:
            "The organization's secrets in this environment's previews: none (the default), or the same as its Runs (owner only; never on a fork's pull request).",
    })
    previewSecrets?: 'none' | 'run';
}

export class ApplyBlockerFixDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(512)
    @ApiProperty({
        example: 'missing_env:STRIPE_SECRET_KEY',
        description: 'The blocker group, as GET /blockers lists it.',
    })
    signature: string;

    @IsString()
    @IsNotEmpty()
    @MaxLength(300)
    @ApiProperty({
        example: 'set_env:STRIPE_SECRET_KEY',
        description: 'One of the fixes the catalog offers for that blocker.',
    })
    fixId: string;

    @IsOptional()
    @IsIn(EGRESS_APPROVAL_MODES)
    @ApiPropertyOptional({ enum: EGRESS_APPROVAL_MODES, description: 'For an allow-host fix: inspected (default, reads only) or passthrough (full access, the second step).' })
    mode?: EgressApprovalMode;
}

export class SimulateRunDto {
    @ValidateIf((o) => o.prNumber !== undefined || o.prNumbers === undefined)
    @ValidateBy({
        name: 'oneSimulationSelection',
        validator: {
            validate: (_value, args) => (args!.object as SimulateRunDto).prNumbers === undefined,
            defaultMessage: () => 'Provide either prNumber or prNumbers',
        },
    })
    @IsInt()
    @Min(1)
    @Max(Number.MAX_SAFE_INTEGER)
    @ApiPropertyOptional({
        example: 42,
        description:
            'One pull request of the repository, instead of prNumbers; nothing is posted on it.',
    })
    prNumber?: number;

    @ValidateIf((o) => o.prNumbers !== undefined)
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(5)
    @ArrayUnique()
    @IsInt({ each: true })
    @Min(1, { each: true })
    @Max(Number.MAX_SAFE_INTEGER, { each: true })
    @ApiPropertyOptional({
        type: [Number],
        minItems: 1,
        maxItems: 5,
        uniqueItems: true,
        example: [42, 43],
        description: 'One to five unique historical PR numbers, instead of prNumber. All are enqueued together; nothing is posted on them.',
    })
    prNumbers?: number[];

    @IsOptional()
    @IsString()
    @IsNotEmpty()
    @MaxLength(ID_MAX)
    @ApiPropertyOptional({ description: "The repository of the environment the PRs are in; default: the environment's primary repository." })
    repositoryId?: string;
}

export class AddEnvironmentRepositoryDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(ID_MAX)
    @ApiProperty({ description: 'A repository connected to Kodus.' })
    repositoryId: string;

    @IsOptional()
    @IsString()
    @MaxLength(63)
    @ApiPropertyOptional({ example: 'billing', description: "Its directory in the workspace (ws/<alias>); default: the repository's short name." })
    alias?: string;

    @IsOptional()
    @IsBoolean()
    @ApiPropertyOptional({ default: true, description: 'A pull request of this repository starts a Run of this environment.' })
    triggers?: boolean;

    @IsOptional()
    @IsBoolean()
    @ApiPropertyOptional({ default: false, description: "A Run boots this repository's open PR of the same branch name instead of its default branch." })
    pairBranches?: boolean;
}

export class UpdateEnvironmentRepositoryDto {
    @IsOptional()
    @IsString()
    @MaxLength(63)
    @ApiPropertyOptional({ example: 'billing', description: 'Its directory in the workspace; a new one asks for a setup.' })
    alias?: string;

    @IsOptional()
    @IsBoolean()
    @ApiPropertyOptional({ description: 'A pull request of this repository starts a Run of this environment.' })
    triggers?: boolean;

    @IsOptional()
    @IsBoolean()
    @ApiPropertyOptional({ description: "A Run boots this repository's open PR of the same branch name instead of its default branch." })
    pairBranches?: boolean;
}

/** A field left out is kept; at least one is required (the use case says which). */
export class UpdateRuntimeOrgSettingsDto {
    @IsOptional()
    @IsInt()
    @Min(1)
    @ApiPropertyOptional({
        type: Number,
        nullable: true,
        example: 5_000_000,
        description: 'Daily token budget; null removes it.',
    })
    tokenBudgetPerDay?: number | null;

    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(100)
    @ApiPropertyOptional({
        type: Number,
        nullable: true,
        example: 50,
        description:
            "Percent of a Run's measured changed lines that must run for a green Run to stay green; below it the Run is partly tested. 0 never holds a Run back; null goes back to the deployment's (RUNTIME_EXERCISED_LINES_THRESHOLD_PERCENT).",
    })
    exercisedLinesThresholdPercent?: number | null;

    @IsOptional()
    @IsNumber({ allowNaN: false, allowInfinity: false })
    @IsPositive()
    @Max(MAX_USD_PER_HOST_HOUR)
    @ApiPropertyOptional({
        type: Number,
        nullable: true,
        example: 0.1344,
        description:
            "US$ one hour of the org's own host costs. With it, the machine time of the org's own cells is priced by the share of the host each claim held; null leaves it unpriced.",
    })
    machineUsdPerHostHour?: number | null;

    @IsOptional()
    @IsIn(PARTLY_TESTED_CHECKS)
    @ApiPropertyOptional({
        enum: PARTLY_TESTED_CHECKS,
        nullable: true,
        example: 'neutral',
        description:
            "What the check of a partly tested Run with something left to decide concludes: action_required (the default), which a branch protection does not pass, or neutral, which it does. A Run with nothing to test stays neutral, and a PR boot the egress proxy stopped stays action_required, either way. null goes back to the default. A Run already asked keeps the value it started with.",
    })
    partlyTestedCheck?: PartlyTestedCheck | null;
}

export class UpdateRuntimeMachineMinutesDto {
    @ValidateIf((o) => o.minutesPerDay !== null)
    @IsInt()
    @Min(1)
    @Max(14_400_000)
    @ApiProperty({
        type: Number,
        nullable: true,
        example: 600,
        description: "The org's own daily machine minutes (UTC day), below the deployment's; null goes back to the deployment's.",
    })
    minutesPerDay: number | null;
}

export class UpdateRepositoryRuntimeSettingsDto {
    @IsOptional()
    @IsIn(['off', 'on_request', 'rules'])
    @ApiPropertyOptional({ enum: ['off', 'on_request', 'rules'] })
    mode?: 'off' | 'on_request' | 'rules';

    /** Validated by the trigger-rule grammar in the use case. */
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(20)
    @ApiPropertyOptional({ type: 'array', items: { type: 'object' } })
    rules?: unknown[];

    @IsOptional()
    @IsBoolean()
    @ApiPropertyOptional()
    runOnAgentPullRequests?: boolean;

    @IsOptional()
    @IsBoolean()
    @ApiPropertyOptional()
    runOnNewPushes?: boolean;

    @IsOptional()
    @IsIn(['maintainers', 'writers', 'anyone_in_org'])
    @ApiPropertyOptional({ enum: ['maintainers', 'writers', 'anyone_in_org'] })
    whoCanAsk?: 'maintainers' | 'writers' | 'anyone_in_org';

    /** The old switch: true keeps the mode (or on_request), false is off. */
    @IsOptional()
    @IsBoolean()
    @ApiPropertyOptional({ deprecated: true })
    pilot?: boolean;
}

export class RunAgainDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(ID_MAX)
    @ApiProperty({ description: 'The finished Run to run again.' })
    runId: string;
}

export class FindingFeedbackDto {
    @IsIn(['up', 'down', null])
    @ApiProperty({
        enum: ['up', 'down'],
        nullable: true,
        description: 'null clears the vote.',
    })
    value: 'up' | 'down' | null;
}

export class ListRuntimeRunsQueryDto {
    @IsOptional()
    @IsString()
    @MaxLength(ID_MAX)
    @ApiPropertyOptional()
    repositoryId?: string;

    @IsOptional()
    @IsInt()
    @Min(1)
    @ApiPropertyOptional({ description: 'Needs repositoryId.' })
    prNumber?: number;

    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(200)
    @ApiPropertyOptional({ default: 50, maximum: 200 })
    limit?: number;
}

export class ReadRunStreamQueryDto {
    @IsOptional()
    @IsString()
    @MaxLength(512)
    @ApiPropertyOptional({
        description: 'Opaque Stream-Next-Offset of the previous read.',
    })
    offset?: string;

    @IsOptional()
    @IsIn(['long-poll'])
    @ApiPropertyOptional({ enum: ['long-poll'] })
    live?: 'long-poll';
}

export class RunEvidenceQueryDto {
    @IsOptional()
    @IsString()
    @MaxLength(32)
    @ApiPropertyOptional()
    side?: string;

    @IsOptional()
    @IsString()
    @MaxLength(32)
    @ApiPropertyOptional()
    type?: string;
}

export class SetTeamCliKeyRepositoriesDto {
    @IsArray()
    @ArrayMaxSize(500)
    @IsString({ each: true })
    @IsNotEmpty({ each: true })
    @MaxLength(ID_MAX, { each: true })
    @ApiProperty({
        type: String,
        isArray: true,
        description:
            'Replaces the list; every repo must be configured for the key team.',
    })
    repositoryIds: string[];
}

export class FindingIntentDto {
    // Typed unknown on purpose: a boolean type lets implicit conversion read "yes" as true.
    @IsIn([true, false])
    @ApiProperty({ type: Boolean, description: 'true marks the finding as an intended change; false clears the mark. The Run, its check and the PR comment do not change.' })
    intended: unknown;
}

export class OpenRuntimePreviewDto {
    @IsIn(['pr', 'base'])
    @ApiProperty({ enum: ['pr', 'base'], description: 'Which side of the Run to open: the pull request or its base.' })
    side: 'pr' | 'base';
}

export class RuntimePreviewGrantDto {
    @IsOptional()
    @IsString()
    @MaxLength(2048)
    @ApiPropertyOptional({ description: 'The path on the preview host to land on after the grant exchange; / by default.' })
    to?: string;
}

export class KeepRuntimeCheckDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(ID_MAX)
    @ApiProperty({ description: 'The Run whose finding to keep.' })
    runId: string;

    @IsString()
    @IsNotEmpty()
    @MaxLength(ID_MAX)
    @ApiProperty({ description: 'The probe of the finding (its path on the Run page).' })
    probeId: string;
}

export class ListRuntimeKeptChecksQueryDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(ID_MAX)
    @ApiProperty({ description: 'The environment whose kept checks to list.' })
    environmentId: string;

    @IsOptional()
    @IsString()
    @MaxLength(ID_MAX)
    @ApiPropertyOptional({ description: 'One repository of the environment.' })
    repositoryId?: string;
}
