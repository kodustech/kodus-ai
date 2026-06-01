import {
    IsString,
    IsOptional,
    IsArray,
    IsBoolean,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ProgrammingLanguage } from '@libs/core/domain/enums/programming-language.enum';
import { PaginationDto } from '@libs/core/domain/dtos/pagination.dto';
import { KodyRuleFilters } from '@libs/core/infrastructure/config/types/general/kodyRules.type';
import { ApiPropertyOptional } from '@nestjs/swagger';

const transformToArray = ({ value }: { value: unknown }): string[] => {
    if (typeof value === 'string') {
        return value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
    }
    return Array.isArray(value) ? value : [];
};

export class FindLibraryKodyRulesDto
    extends PaginationDto
    implements KodyRuleFilters
{
    private static transformToBoolean = ({ value }: { value: unknown }) => {
        if (value === 'true') return true;
        if (value === 'false') return false;
        return value;
    };
    @IsOptional()
    @IsString()
    @ApiPropertyOptional()
    title?: string;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional()
    severity?: string;

    @IsOptional()
    @Transform(transformToArray)
    @IsArray()
    @IsString({ each: true })
    @ApiPropertyOptional()
    tags?: string[];

    @IsOptional()
    @IsBoolean()
    @Transform(FindLibraryKodyRulesDto.transformToBoolean)
    @ApiPropertyOptional()
    plug_and_play?: boolean;

    @IsOptional()
    @IsBoolean()
    @Transform(FindLibraryKodyRulesDto.transformToBoolean)
    @ApiPropertyOptional()
    needMCPS?: boolean;

    @IsOptional()
    @ApiPropertyOptional({
        enum: ProgrammingLanguage,
        enumName: 'ProgrammingLanguage',
    })
    language?: ProgrammingLanguage;

    @IsOptional()
    @Transform(transformToArray)
    @IsArray()
    @IsString({ each: true })
    @ApiPropertyOptional()
    buckets?: string[];
}
