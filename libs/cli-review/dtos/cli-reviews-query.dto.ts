import { IsInt, IsISO8601, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CliReviewsQueryDto {
    @IsOptional()
    @IsString()
    teamId?: string;

    @IsOptional()
    @IsString()
    repositoryId?: string;

    @IsOptional()
    @IsString()
    userEmail?: string;

    @IsOptional()
    @IsISO8601()
    since?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    pageSize?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    page?: number;
}
