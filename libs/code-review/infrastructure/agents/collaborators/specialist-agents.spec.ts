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
                    error: {
                        message: 'invalid key sk-live-123 for org acme',
                        status: 401,
                    },
                },
            ],
            {},
        );

        expect(entry.error).toBeTruthy();
        expect(entry.error).not.toContain('sk-live-123');
    });
});
