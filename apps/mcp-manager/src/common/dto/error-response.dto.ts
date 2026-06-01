import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ErrorResponseDto {
    @ApiProperty({ example: 400 })
    statusCode: number;

    @ApiProperty({ example: '2026-02-05T12:00:00.000Z' })
    timestamp: string;

    @ApiProperty({ example: '/mcp/connections' })
    url: string;

    @ApiProperty({ example: 'GET' })
    method: string;

    @ApiProperty({ example: 'Bad Request' })
    message: string;

    @ApiProperty({ example: 'BAD_REQUEST' })
    code: string;

    @ApiPropertyOptional({
        description: 'Additional error details when available',
        example: { field: 'validation error' },
    })
    details?: any;
}
