import { IsISO8601, IsNumber, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TokenUsageQueryDto {
    @IsISO8601()
    @ApiProperty()
    startDate: string; // ISO date string

    @IsISO8601()
    @ApiProperty()
    endDate: string; // ISO date string

    @IsOptional()
    @IsString()
    @ApiPropertyOptional()
    models?: string;

    @IsOptional()
    @IsNumber()
    @ApiPropertyOptional({ type: Number })
    prNumber?: number;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional()
    timezone?: string; // e.g., 'UTC' or 'America/Sao_Paulo'

    @IsOptional()
    @IsString()
    @ApiPropertyOptional()
    developer?: string;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional({
        description:
            'Scope results to one repository (resolved to its PR numbers).',
    })
    repositoryId?: string;

    @IsString()
    @ApiProperty()
    byok: string;
}

export class TokenPricingQueryDto {
    @IsString()
    @ApiProperty()
    model: string;

    @IsString()
    @IsOptional()
    @ApiPropertyOptional()
    provider?: string;
}
