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
});
