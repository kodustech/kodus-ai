import {
    IKodyRuleCentralizedConfig,
    IKodyRuleExternalReference,
    IKodyRuleReferenceSyncError,
    KodyRuleCentralizedStatus,
    IKodyRulesExample,
    KodyRuleProcessingStatus,
    KodyRuleRequestType,
    KodyRulesOrigin,
    KodyRulesScope,
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    IsArray,
    IsBoolean,
    IsDate,
    IsEnum,
    IsNotEmpty,
    IsOptional,
    IsString,
    ValidateNested,
} from 'class-validator';

export enum KodyRuleSeverity {
    LOW = 'low',
    MEDIUM = 'medium',
    HIGH = 'high',
    CRITICAL = 'critical',
}

export class KodyRulesExampleDto implements IKodyRulesExample {
    @IsString()
    @ApiProperty({ example: 'if (value == null) return;' })
    snippet: string;

    @IsBoolean()
    @ApiProperty({ example: true })
    isCorrect: boolean;
}

export class KodyRulesInheritanceDto {
    @IsBoolean()
    @ApiProperty({ example: true })
    inheritable: boolean;

    @IsArray()
    @IsString({ each: true })
    @IsOptional()
    @ApiPropertyOptional({
        type: String,
        isArray: true,
        example: ['src/legacy/**'],
    })
    exclude: string[];

    @IsArray()
    @IsString({ each: true })
    @IsOptional()
    @ApiPropertyOptional({ type: String, isArray: true, example: ['src/**'] })
    include: string[];
}

export class KodyRuleExternalReferenceDto implements IKodyRuleExternalReference {
    @IsString()
    @ApiProperty({ example: 'src/services/user.service.ts' })
    filePath: string;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional({
        example: 'Reference implementation in user service',
    })
    description?: string;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional({ example: 'kodus-ai' })
    repositoryName?: string;
}

export class KodyRuleCentralizedConfigDto implements IKodyRuleCentralizedConfig {
    @IsString()
    @ApiProperty({ example: 'repo-a/.kody-rules/review/no-debug.yml' })
    path: string;

    @IsEnum(KodyRuleCentralizedStatus)
    @ApiProperty({
        enum: KodyRuleCentralizedStatus,
        enumName: 'KodyRuleCentralizedStatus',
        example: KodyRuleCentralizedStatus.PENDING_EDIT,
    })
    status: KodyRuleCentralizedStatus;
}

export class CreateKodyRuleDto {
    @IsOptional()
    @IsString()
    @ApiPropertyOptional({
        format: 'uuid',
        example: '1e6f6a92-5b4b-4b7d-9c31-4f55f4e9cbd1',
    })
    uuid?: string;

    @IsNotEmpty()
    @IsEnum(KodyRulesType)
    @ApiProperty({
        enum: KodyRulesType,
        enumName: 'KodyRulesType',
        example: KodyRulesType.STANDARD,
    })
    type: KodyRulesType;

    @IsNotEmpty()
    @IsString()
    @ApiProperty({ example: 'Avoid null comparisons' })
    title: string;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional({
        enum: KodyRulesScope,
        enumName: 'KodyRulesScope',
        example: KodyRulesScope.FILE,
    })
    scope?: KodyRulesScope;

    @IsNotEmpty()
    @IsString()
    @ApiProperty({
        example:
            'Avoid comparing to null; prefer strict checks or type guards.',
    })
    rule: string;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional({ example: 'src/services' })
    path: string;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional({ example: 'src/services/user.service.ts' })
    sourcePath?: string;

    @IsOptional()
    @ValidateNested()
    @Type(() => KodyRuleCentralizedConfigDto)
    @ApiPropertyOptional({ type: KodyRuleCentralizedConfigDto })
    centralizedConfig?: KodyRuleCentralizedConfigDto;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional({ example: 'L10-L24' })
    sourceAnchor?: string;

    @IsNotEmpty()
    @IsEnum(KodyRuleSeverity)
    @ApiProperty({ enum: KodyRuleSeverity, enumName: 'KodyRuleSeverity' })
    severity: KodyRuleSeverity;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional({
        description:
            'Team identifier used to resolve team-scoped centralized configuration for global Kody Rules.',
        example: '2e4f7a61-3c8c-4af5-bf25-2d0cbb19c4d1',
    })
    teamId?: string;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional({ example: '1135722979' })
    repositoryId?: string;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional({ example: 'src/services' })
    directoryId?: string;

    @IsEnum(KodyRulesOrigin)
    @ApiProperty({ enum: KodyRulesOrigin, enumName: 'KodyRulesOrigin' })
    origin: KodyRulesOrigin;

    @IsEnum(KodyRulesStatus)
    @IsOptional()
    @ApiPropertyOptional({ enum: KodyRulesStatus, enumName: 'KodyRulesStatus' })
    status?: KodyRulesStatus;

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => KodyRulesExampleDto)
    @ApiPropertyOptional({ type: KodyRulesExampleDto, isArray: true })
    examples: KodyRulesExampleDto[];

    @IsOptional()
    @ValidateNested()
    @Type(() => KodyRulesInheritanceDto)
    @ApiPropertyOptional({ type: KodyRulesInheritanceDto })
    inheritance?: KodyRulesInheritanceDto;

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => KodyRuleExternalReferenceDto)
    @ApiPropertyOptional({ type: KodyRuleExternalReferenceDto, isArray: true })
    externalReferences?: KodyRuleExternalReferenceDto[];

    @IsOptional()
    @ApiPropertyOptional({
        type: Object,
        description: 'Reference sync errors returned by external sources.',
        additionalProperties: true,
    })
    syncErrors?: IKodyRuleReferenceSyncError[];

    @IsOptional()
    @IsEnum(KodyRuleProcessingStatus)
    @ApiPropertyOptional({
        enum: KodyRuleProcessingStatus,
        enumName: 'KodyRuleProcessingStatus',
    })
    referenceProcessingStatus?: KodyRuleProcessingStatus;

    @IsOptional()
    lastReferenceProcessedAt?: Date;

    @IsOptional()
    @IsString()
    ruleHash?: string;

    @IsOptional()
    @IsEnum(KodyRuleRequestType)
    @ApiPropertyOptional({
        enum: KodyRuleRequestType,
        enumName: 'KodyRuleRequestType',
    })
    requestType?: KodyRuleRequestType;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional({
        format: 'uuid',
        description:
            'When this rule is a pending request, target rule to update',
    })
    targetRuleUuid?: string;

    @IsOptional()
    @ApiPropertyOptional({
        type: String,
        format: 'date-time',
    })
    @Type(() => Date)
    @IsDate()
    resolvedAt?: Date;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional({
        description:
            'User id/email/system identifier that resolved the request',
    })
    resolvedBy?: string;

    @IsOptional()
    @IsBoolean()
    @ApiPropertyOptional({
        description:
            'True when the source file currently carries an `@kody-sync` marker — the per-file override that keeps the rule in sync even with `ideRulesSyncEnabled=false`. Set by the sync service, recomputed on every sync.',
    })
    pinnedSync?: boolean;
}
