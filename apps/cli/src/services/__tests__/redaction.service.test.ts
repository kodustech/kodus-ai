import { describe, it, expect } from 'vitest';
import {
    containsUnredactedSecret,
    redactText,
    requireRedacted,
} from '../redaction.service.js';
import { buildTurnStartEvent } from '../lifecycle-events.js';

describe('redaction.service', () => {
    it('redacts recognisable secrets', () => {
        const planted = 'sk-ant-api03-THISISFAKESECRETVALUE1234567890';
        const input = `Please use key ${planted} in the client`;
        const redacted = redactText(input);
        expect(containsUnredactedSecret(redacted, planted)).toBe(false);
        expect(redacted).toContain('[REDACTED]');
    });

    it('redacts github pats and aws keys', () => {
        const gh = 'ghp_abcdefghijklmnopqrstuvwxyz012345';
        const aws = 'AKIAIOSFODNN7EXAMPLE';
        expect(redactText(`token ${gh}`)).not.toContain(gh);
        expect(redactText(`aws ${aws}`)).not.toContain(aws);
    });

    it('typed redaction is required by turn builder signature', () => {
        const prompt = redactText(
            'hello secret sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV',
        );
        const event = buildTurnStartEvent({
            sessionId: 's',
            branch: 'main',
            turnId: 't',
            prompt: requireRedacted(prompt),
            commitBefore: 'abc',
            timestamp: new Date().toISOString(),
        });
        expect(String(event.prompt)).not.toContain(
            'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV',
        );
    });
});
