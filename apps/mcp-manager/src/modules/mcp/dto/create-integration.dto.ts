import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    IsArray,
    IsBoolean,
    IsEnum,
    IsOptional,
    IsString,
    ValidateNested,
} from 'class-validator';
import { StringRecordDto } from '../../../common/dto';
import {
    MCPIntegrationAuthType,
    MCPIntegrationProtocol,
} from '../../integrations/enums/integration.enum';

export class CreateIntegrationDto {
    @ApiPropertyOptional({
        example: 'int_456',
        description: 'Only used by Kodus MCP',
    })
    @IsString()
    @IsOptional()
    integrationId?: string; // Only used by Kodus MCP

    @ApiProperty({ example: 'https://api.example.com' })
    @IsString()
    baseUrl: string;

    @ApiPropertyOptional({ example: 'http' })
    @IsEnum(MCPIntegrationProtocol)
    @IsOptional()
    protocol?: MCPIntegrationProtocol;

    @ApiPropertyOptional({ example: 'Custom Integration' })
    @IsString()
    @IsOptional()
    name?: string;

    @ApiPropertyOptional({ example: 'Integration description' })
    @IsString()
    @IsOptional()
    description?: string;

    @ApiPropertyOptional({ example: 'https://logo.example.com' })
    @IsString()
    @IsOptional()
    logoUrl?: string;

    @ApiPropertyOptional({ type: [StringRecordDto] })
    @IsArray()
    @Type(() => StringRecordDto)
    @ValidateNested({ each: true })
    @IsOptional()
    headers?: StringRecordDto[];

    @ApiPropertyOptional({ example: 'api_key' })
    @IsEnum(MCPIntegrationAuthType)
    @IsOptional()
    authType?: MCPIntegrationAuthType;

    @ApiPropertyOptional({ example: 'token_123' })
    @IsString()
    @IsOptional()
    bearerToken?: string;

    @ApiPropertyOptional({ example: 'apikey_123' })
    @IsString()
    @IsOptional()
    apiKey?: string;

    @ApiPropertyOptional({ example: 'X-API-KEY' })
    @IsString()
    @IsOptional()
    apiKeyHeader?: string;

    @ApiPropertyOptional({ example: 'basic_user' })
    @IsString()
    @IsOptional()
    basicUser?: string;

    @ApiPropertyOptional({ example: 'basic_pass' })
    @IsString()
    @IsOptional()
    basicPassword?: string;

    @ApiPropertyOptional({ type: [String], example: ['scope.read'] })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    oauthScopes?: string[];

    @ApiPropertyOptional({ example: 'client_123' })
    @IsString()
    @IsOptional()
    clientId?: string;

    @ApiPropertyOptional({ example: 'secret_123' })
    @IsString()
    @IsOptional()
    clientSecret?: string;

    @ApiPropertyOptional({ example: false })
    @IsBoolean()
    @IsOptional()
    dynamicRegistration?: boolean;
}
