import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    IsDateString,
    IsInt,
    IsOptional,
    IsPositive,
    Max,
} from 'class-validator';

/** Query for the metered-charges journal. Validation lives here, not in the
 *  controller: a bad `limit` or `before` is a 400 before any handler code. */
export class ListKodusCreditChargesQueryDto {
    @ApiPropertyOptional({ minimum: 1, maximum: 500 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @IsPositive()
    @Max(500)
    limit?: number;

    @ApiPropertyOptional({ description: 'ISO date; only charges before it' })
    @IsOptional()
    @IsDateString()
    before?: string;

    @ApiPropertyOptional({ minimum: 1 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @IsPositive()
    prNumber?: number;
}
