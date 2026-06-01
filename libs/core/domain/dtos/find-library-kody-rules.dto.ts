import { Transform } from 'class-transformer';
import {
    IsString,
    IsOptional,
    IsArray,
    IsBoolean,
} from 'class-validator';

import { ProgrammingLanguage } from '@libs/core/domain/enums/programming-language.enum';
import { KodyRuleFilters } from '@libs/core/infrastructure/config/types/general/kodyRules.type';

import { PaginationDto } from './pagination.dto';
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
    static transformToBoolean({
        value,
    }: {
        value: unknown;
    }): boolean | undefined {
        if (value === undefined || value === null || value === '') {
            return undefined;
        }
        if (typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (['true', '1', 'yes', 'y'].includes(normalized)) {
                return true;
            }
            if (['false', '0', 'no', 'n'].includes(normalized)) {
                return false;
            }
        }
        return Boolean(value);
    }

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
