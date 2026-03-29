import { IsDateString, IsIn, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { SESSION_EVENT_TYPES } from '@libs/cli-review/infrastructure/repositories/schemas/session-event.model';

/**
 * DTO for session event ingestion.
 * Only validates the structural envelope (sessionId, type, branch, timestamp).
 * All remaining fields are stored as-is in the JSONB payload column.
 *
 * Note: this endpoint uses a custom ValidationPipe with whitelist disabled
 * so that extra event-specific fields pass through to the payload.
 */
export class SessionEventRequestDto {
    @IsString()
    @MaxLength(120)
    @ApiProperty({ example: 'sess-abc123' })
    sessionId: string;

    @IsIn(SESSION_EVENT_TYPES)
    @ApiProperty({
        enum: SESSION_EVENT_TYPES,
        example: 'session_start',
    })
    type: (typeof SESSION_EVENT_TYPES)[number];

    @IsString()
    @MaxLength(250)
    @ApiProperty({ example: 'feat/auth' })
    branch: string;

    @IsDateString()
    @ApiProperty({ example: '2025-06-01T10:30:00.000Z' })
    timestamp: string;
}
