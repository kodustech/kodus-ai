import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsArray,
    IsNotEmpty,
    IsObject,
    IsOptional,
    IsString,
} from 'class-validator';

export class InitiateConnectionDto {
    @ApiProperty({ example: 'int_456' })
    @IsString()
    @IsNotEmpty()
    integrationId: string;

    @ApiPropertyOptional({ type: [String], example: ['repo.read'] })
    @IsArray()
    @IsString({ each: true })
    @IsOptional()
    allowedTools?: string[];

    @ApiPropertyOptional({
        description: 'Provider-specific authentication parameters',
        example: { apiKey: '***' },
    })
    @IsObject()
    @IsOptional()
    authParams?: Record<string, any>;
}
