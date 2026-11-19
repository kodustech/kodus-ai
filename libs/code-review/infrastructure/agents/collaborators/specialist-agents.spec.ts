import { finishedSpecialists } from './specialist-agents';

describe('finishedSpecialists', () => {
    it('shows a failed lens by its classified reason, never the raw provider text', () => {
        const [entry] = finishedSpecialists(
            [
                {
                    label: 'lens-data-exposure',
                    status: 'failed',
                    found: 0,
                    ms: 10,
                    steps: 1,
                    toolCalls: 0,
                    // No status: nothing to classify by, so the text is
                    // all the classifier has.
                    error: {
                        message: 'upstream said: key sk-live-123 for org acme',
                    },
                },
            ],
            {},
        );

        expect(entry.error).toBeTruthy();
        expect(entry.error).not.toContain('sk-live-123');
    });

    it('keeps the provider text out of a refused request too', () => {
        const [entry] = finishedSpecialists(
            [
                {
                    label: 'lens-data-exposure',
                    status: 'failed',
                    found: 0,
                    ms: 10,
                    steps: 1,
                    toolCalls: 0,
                    error: {
                        status: 400,
                        message: 'invalid request',
                        responseBody:
                            '{"error":{"message":"bad input near sk-live-123"}}',
                    },
                },
            ],
            {},
            undefined,
            'openai_compatible',
        );

        expect(entry.error).toBe(
            'The provider (openai_compatible) refused the request for this model.',
        );
    });
});
