import {
    IsArray,
    IsEnum,
    IsNotEmpty,
    IsOptional,
    IsString,
    ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { KodyRuleSeverity } from './create-kody-rule.dto';
import { KodyRulesScope } from '@/core/domain/kodyRules/interfaces/kodyRules.interface';

class ImportFastKodyRuleItemDto {
    @IsString()
    @IsNotEmpty()
    title: string;

    @IsString()
    @IsNotEmpty()
    rule: string;

    @IsString()
    @IsNotEmpty()
    path: string;

    @IsString()
    @IsNotEmpty()
    sourcePath: string;

    @IsString()
    @IsNotEmpty()
    repositoryId: string;

    @IsOptional()
    @IsEnum(KodyRuleSeverity)
    severity?: KodyRuleSeverity;

    @IsOptional()
    @IsEnum(KodyRulesScope)
    scope?: KodyRulesScope;

    @IsOptional()
    examples?: Array<{ snippet: string; isCorrect: boolean }>;
}

export class ImportFastKodyRulesDto {
    @IsString()
    @IsNotEmpty()
    teamId: string;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => ImportFastKodyRuleItemDto)
    rules: ImportFastKodyRuleItemDto[];
}
