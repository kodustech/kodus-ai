import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsArray,
    IsNotEmpty,
    IsObject,
    IsOptional,
    IsString,
} from 'class-validator';

export class ConnectTokenDto {
    @ApiPropertyOptional({
        description:
            'Selected token auth method id (defaults to the integration default token method).',
        example: 'token',
    })
    @IsString()
    @IsOptional()
    authMethod?: string;

    @ApiProperty({
        description: 'The user-supplied secret (API token / personal token).',
        example: '***',
    })
    @IsString()
    @IsNotEmpty()
    secret: string;

    @ApiPropertyOptional({
        description:
            'Non-secret fields required by the method (e.g. Jira email + cloudId).',
        example: { email: 'dev@kodus.io', cloudId: 'abc-123' },
    })
    @IsObject()
    @IsOptional()
    fields?: Record<string, string>;

    @ApiPropertyOptional({ type: [String], example: ['list_issues'] })
    @IsArray()
    @IsString({ each: true })
    @IsOptional()
    allowedTools?: string[];
}
