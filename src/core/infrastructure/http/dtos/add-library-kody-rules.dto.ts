import {
    IsOptional,
    IsString,
    IsNotEmpty,
    IsEnum,
    IsArray,
    ValidateNested,
} from 'class-validator';
import { KodyRulesExampleDto } from './create-kody-rule.dto';
import { Type } from 'class-transformer';
import {
    KodyRulesOrigin,
    KodyRulesStatus,
} from '@/core/domain/kodyRules/interfaces/kodyRules.interface';

export enum KodyRuleSeverity {
    LOW = 'low',
    MEDIUM = 'medium',
    HIGH = 'high',
    CRITICAL = 'critical',
}

export class AddLibraryKodyRulesDto {
    @IsOptional()
    @IsString()
    uuid?: string;

    @IsNotEmpty()
    @IsString()
    title: string;

    @IsNotEmpty()
    @IsString()
    rule: string;

    @IsOptional()
    @IsString()
    path: string;

    @IsNotEmpty()
    @IsEnum(KodyRuleSeverity)
    severity: KodyRuleSeverity;

    @IsArray()
    @IsString({ each: true })
    repositoriesIds: string[];

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => KodyRulesExampleDto)
    examples: KodyRulesExampleDto[];

    @IsOptional()
    @IsEnum(KodyRulesOrigin)
    origin?: KodyRulesOrigin;

    @IsOptional()
    @IsEnum(KodyRulesStatus)
    status?: KodyRulesStatus;
}
