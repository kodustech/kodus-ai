import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsEnum, IsUUID } from 'class-validator';

import { PaginationDto } from '@libs/core/domain/dtos/pagination.dto';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
    ActionType,
    ConfigLevel,
} from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';

export class CodeReviewSettingsLogFiltersDto extends PaginationDto {
    @IsOptional()
    @IsUUID()
    @ApiPropertyOptional()
    teamId?: string;

    @IsOptional()
    @IsEnum(ActionType)
    @ApiPropertyOptional({ enum: ActionType, enumName: 'ActionType' })
    action?: ActionType;

    @IsOptional()
    @IsEnum(ConfigLevel)
    @ApiPropertyOptional({ enum: ConfigLevel, enumName: 'ConfigLevel' })
    configLevel?: ConfigLevel;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional()
    userId?: string;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional()
    userEmail?: string;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional()
    repositoryId?: string;

    @IsOptional()
    @Transform(({ value }) => new Date(value))
    @ApiPropertyOptional()
    startDate?: Date;

    @IsOptional()
    @Transform(({ value }) => new Date(value))
    @ApiPropertyOptional()
    endDate?: Date;
}
