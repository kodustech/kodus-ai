import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    ArrayMaxSize,
    IsArray,
    IsOptional,
    IsString,
    IsUUID,
} from 'class-validator';

/** More git ids than any list has. */
const MAX_IDS = 10000;

export class UpdateAuthorFiltersDto {
    @ApiPropertyOptional({
        format: 'uuid',
        description:
            "The Git connection whose lists change; the organization's when absent.",
    })
    @IsOptional()
    @IsUUID('4')
    connectionId?: string;

    @ApiProperty({ type: [String], description: 'Git ids never reviewed.' })
    @IsArray()
    @ArrayMaxSize(MAX_IDS)
    @IsString({ each: true })
    ignoredUsers: string[];

    @ApiProperty({
        type: [String],
        description: 'Git ids reviewed; everyone when empty.',
    })
    @IsArray()
    @ArrayMaxSize(MAX_IDS)
    @IsString({ each: true })
    allowedUsers: string[];
}
