import { describe, expect, it } from 'vitest';
import {
    buildAgentErrorEnvelope,
    buildAgentSuccessEnvelope,
} from '../command-output.js';

describe('command output envelope', () => {
    it('builds success envelope with required metadata', () => {
        const envelope = buildAgentSuccessEnvelope(
            'review',
            { summary: 'ok' },
            10,
        );

        expect(envelope.ok).toBe(true);
        expect(envelope.command).toBe('review');
        expect(envelope.data).toEqual({ summary: 'ok' });
        expect(envelope.error).toBeNull();
        expect(envelope.meta.schemaVersion).toBe('1.0');
        expect(envelope.meta.mode).toBe('agent');
        expect(envelope.meta.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('builds error envelope with code and message', () => {
        const envelope = buildAgentErrorEnvelope(
            'pr suggestions',
            {
                code: 'INVALID_INPUT',
                message: 'Invalid --pr-number value',
                details: { flag: '--pr-number' },
            },
            5,
        );

        expect(envelope.ok).toBe(false);
        expect(envelope.command).toBe('pr suggestions');
        expect(envelope.data).toBeNull();
        expect(envelope.error?.code).toBe('INVALID_INPUT');
        expect(envelope.error?.message).toBe('Invalid --pr-number value');
        expect(envelope.error?.details).toEqual({ flag: '--pr-number' });
        expect(envelope.meta.schemaVersion).toBe('1.0');
    });
});
