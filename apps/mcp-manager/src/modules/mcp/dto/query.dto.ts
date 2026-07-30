import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class QueryDto {
    @ApiPropertyOptional({ example: 1, description: 'Page number (1-based)' })
    @IsNumber()
    @IsOptional()
    @Type(() => Number)
    @Min(1, {
        message:
            'page must be a number conforming to the specified constraints',
    })
    page = 1;

    @ApiPropertyOptional({
        example: 50,
        description: 'Number of items per page',
    })
    @IsNumber()
    @IsOptional()
    @Type(() => Number)
    @Min(1, {
        message:
            'pageSize must be a number conforming to the specified constraints',
    })
    pageSize = 50;

    @ApiPropertyOptional({ example: 'kodusmcp' })
    @IsString()
    @IsOptional()
    provider: string;

    @ApiPropertyOptional({ example: 'GitHub' })
    @IsString()
    @IsOptional()
    appName: string;

    // NOTE: organizationId is intentionally NOT a query field. The tenant scope
    // is derived from the authenticated request (request.organizationId) and
    // injected server-side. Accepting it here let a client override the tenant
    // (cross-tenant leak) via the `...where` spread in McpService.getConnections.

    @ApiPropertyOptional({ example: 'int_456' })
    @IsString()
    @IsOptional()
    integrationId: string;

    @ApiPropertyOptional({ example: 'ACTIVE' })
    @IsString()
    @IsOptional()
    status: string;
}
