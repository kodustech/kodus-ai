import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class InitiateOAuthDto {
    @ApiProperty({ example: 'int_456' })
    @IsString()
    integrationId: string;

    @ApiPropertyOptional({
        description:
            'Selected auth method id for multi-method integrations (defaults to the integration default).',
        example: 'oauth',
    })
    @IsString()
    @IsOptional()
    authMethod?: string;
}
