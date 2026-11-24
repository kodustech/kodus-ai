import { readScanVerdict, SCAN_VERIFY_TOOL } from './scan-verifier';

const state = (over: Record<string, unknown>) =>
    ({
        status: 'completed',
        steps: [],
        artifacts: [],
        trace: [],
        usage: {},
        ...over,
    }) as any;

describe('readScanVerdict', () => {
    it('reads the verdict tool payload', () => {
        const verdict = readScanVerdict(
            state({
                artifacts: [
                    {
                        type: SCAN_VERIFY_TOOL,
                        payload: {
                            keep: false,
                            severity: 'low',
                            assumption: '',
                            rationale: 'RABBITMQ_DEFAULT_USER replaces guest',
                        },
                    },
                ],
            }),
        );
        expect(verdict).toEqual({
            keep: false,
            severity: 'low',
            assumption: undefined,
            rationale: 'RABBITMQ_DEFAULT_USER replaces guest',
            judged: true,
        });
    });

    it('reads a verdict written as JSON in the final answer', () => {
        const verdict = readScanVerdict(
            state({
                steps: [
                    {
                        message: {
                            content:
                                'Checked the callers.\n{"keep": "true", "severity": "MEDIUM", "assumption": "port 9000 is public", "rationale": "reached"}',
                        },
                    },
                ],
            }),
        );
        expect(verdict).toMatchObject({
            keep: true,
            severity: 'medium',
            assumption: 'port 9000 is public',
            judged: true,
        });
    });

    it('ignores a severity outside the scale', () => {
        const verdict = readScanVerdict(
            state({
                artifacts: [
                    {
                        type: SCAN_VERIFY_TOOL,
                        payload: { keep: true, severity: 'urgent', rationale: 'x' },
                    },
                ],
            }),
        );
        expect(verdict.severity).toBeUndefined();
        expect(verdict.keep).toBe(true);
    });

    it('keeps the finding unjudged when the run failed or gave no verdict', () => {
        expect(readScanVerdict(state({ status: 'error' }))).toMatchObject({
            keep: true,
            judged: false,
        });
        expect(
            readScanVerdict(
                state({
                    status: 'max-steps',
                    steps: [{ message: { content: 'still reading' } }],
                }),
            ),
        ).toMatchObject({ keep: true, judged: false });
    });
});
