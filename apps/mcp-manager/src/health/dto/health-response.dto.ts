import { ApiProperty } from '@nestjs/swagger';

export class HealthMemoryDto {
    @ApiProperty({ example: 42 })
    used: number;

    @ApiProperty({ example: 128 })
    total: number;
}

export class HealthResponseDto {
    @ApiProperty({ example: 'ok' })
    status: string;

    @ApiProperty({ example: '2026-02-05T12:00:00.000Z' })
    timestamp: string;

    @ApiProperty({ example: '12345s' })
    uptime: string;

    @ApiProperty({ example: 'development' })
    environment: string;

    @ApiProperty({ example: '0.0.1' })
    version: string;

    @ApiProperty({ example: 'connected' })
    database: string;

    @ApiProperty({ type: HealthMemoryDto })
    memory: HealthMemoryDto;
}
