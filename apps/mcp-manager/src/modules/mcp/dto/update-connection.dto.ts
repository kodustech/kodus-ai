import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsNotEmpty,
    IsObject,
    IsOptional,
    IsString,
    IsArray,
} from 'class-validator';

export class UpdateConnectionDto {
    @ApiProperty({ example: 'int_456' })
    @IsString()
    @IsNotEmpty()
    integrationId: string;

    @ApiPropertyOptional({ example: 'ACTIVE' })
    @IsString()
    @IsOptional()
    status?: string;

    @ApiPropertyOptional({
        description: 'Metadata to merge into existing connection metadata',
        example: { note: 'Updated by admin' },
    })
    @IsObject()
    @IsOptional()
    metadata?: Record<string, any>;
}

export class UpdateAllowedToolsDto {
    @ApiProperty({ type: [String], example: ['repo.read', 'issue.create'] })
    @IsArray()
    @IsString({ each: true })
    allowedTools: string[];
}
