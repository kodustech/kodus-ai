import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SessionEventRequestDto } from '../session-event.dto';

function toDto(plain: Record<string, unknown>): SessionEventRequestDto {
    return plainToInstance(SessionEventRequestDto, plain);
}

describe('SessionEventRequestDto', () => {
    const validPayload = {
        sessionId: 'sess-abc123',
        type: 'session_start',
        branch: 'feat/auth',
        timestamp: '2025-06-01T10:30:00.000Z',
    };

    it('accepts a valid payload', async () => {
        const errors = await validate(toDto(validPayload));
        expect(errors).toHaveLength(0);
    });

    it('accepts all 6 valid event types', async () => {
        const types = [
            'session_start',
            'turn_start',
            'turn_end',
            'subagent_start',
            'subagent_end',
            'session_end',
        ];

        for (const type of types) {
            const errors = await validate(toDto({ ...validPayload, type }));
            expect(errors).toHaveLength(0);
        }
    });

    it('rejects invalid event type', async () => {
        const errors = await validate(
            toDto({ ...validPayload, type: 'invalid_type' }),
        );
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0].property).toBe('type');
    });

    it('rejects missing sessionId', async () => {
        const { sessionId, ...rest } = validPayload;
        const errors = await validate(toDto(rest));
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.some((e) => e.property === 'sessionId')).toBe(true);
    });

    it('rejects missing type', async () => {
        const { type, ...rest } = validPayload;
        const errors = await validate(toDto(rest));
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.some((e) => e.property === 'type')).toBe(true);
    });

    it('rejects missing branch', async () => {
        const { branch, ...rest } = validPayload;
        const errors = await validate(toDto(rest));
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.some((e) => e.property === 'branch')).toBe(true);
    });

    it('rejects missing timestamp', async () => {
        const { timestamp, ...rest } = validPayload;
        const errors = await validate(toDto(rest));
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.some((e) => e.property === 'timestamp')).toBe(true);
    });

    it('rejects invalid timestamp format', async () => {
        const errors = await validate(
            toDto({ ...validPayload, timestamp: 'not-a-date' }),
        );
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0].property).toBe('timestamp');
    });

    it('rejects sessionId longer than 120 chars', async () => {
        const errors = await validate(
            toDto({
                ...validPayload,
                sessionId: 'x'.repeat(121),
            }),
        );
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0].property).toBe('sessionId');
    });

    it('rejects branch longer than 250 chars', async () => {
        const errors = await validate(
            toDto({
                ...validPayload,
                branch: 'x'.repeat(251),
            }),
        );
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0].property).toBe('branch');
    });

    it('rejects non-string sessionId', async () => {
        const errors = await validate(
            toDto({ ...validPayload, sessionId: 12345 }),
        );
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0].property).toBe('sessionId');
    });
});
