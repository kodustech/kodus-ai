import { IsString, IsOptional, IsArray } from 'class-validator';
import { KodyRuleFilters } from '@/config/types/kodyRules.type';
import { ProgrammingLanguage } from '@/shared/domain/enums/programming-language.enum';

export class FindLibraryKodyRulesDto implements KodyRuleFilters {
    @IsOptional()
    @IsString()
    title?: string;

    @IsOptional()
    @IsString()
    severity?: string;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    tags?: string[];

    @IsOptional()
    language?: ProgrammingLanguage;
}
