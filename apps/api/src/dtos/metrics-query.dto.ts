import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional } from 'class-validator';

/**
 * Query of the internal metrics endpoints. A value that is not a whole number
 * is a 400 here; the use cases bound a valid one (1 to 1440 minutes, 1 to 168
 * hours) and fall back to the default when it is absent or 0.
 */
export class MetricsWindowQueryDto {
    @ApiPropertyOptional({
        description: 'Window in minutes (1 to 1440). Default: 15',
        example: 15,
    })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    window?: number;
}

export class MetricsHoursQueryDto {
    @ApiPropertyOptional({
        description: 'Window in hours (1 to 168). Default: 24',
        example: 24,
    })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    hours?: number;
}
