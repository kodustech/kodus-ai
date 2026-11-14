import { LLM } from '@libs/llm/llm';
import { tracedEmbed } from '@libs/llm/llm-call';
import { buildPlatformEmbedder } from '@libs/common/utils/document';

import { createFindingDedupDeps, deduplicateFindings } from './finding-dedup';

// Deterministic: the "no model" branch must not depend on the host's env keys.
jest.mock('@libs/llm/managed-slot', () => {
    const actual = jest.requireActual('@libs/llm/managed-slot');
    return { ...actual, hasManagedModelKey: jest.fn(() => false) };
});
// No platform embedding key: a merge the lexical check does not settle goes
// to the tiebreak, never to the network.
jest.mock('@libs/common/utils/document', () => {
    const actual = jest.requireActual('@libs/common/utils/document');
    return { ...actual, buildPlatformEmbedder: jest.fn(() => null) };
});

jest.mock('@libs/llm/llm-call', () => {
    const actual = jest.requireActual('@libs/llm/llm-call');
    return { ...actual, tracedEmbed: jest.fn(actual.tracedEmbed) };
});

describe('deduplicateFindings with createFindingDedupDeps', () => {
    const slot = { provider: 'openai', model: 'gpt-4o-mini' } as any;
    const telemetryMeta = { organizationId: 'org-1', teamId: 'team-1' } as any;

    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const makeDeps = () =>
        createFindingDedupDeps({
            logger: logger as any,
            context: 'SecurityScan',
        });

    const dupA = () => ({
        relevantFile: 'src/user.ts',
        relevantLinesStart: 10,
        relevantLinesEnd: 12,
        label: 'security',
        severity: 'high',
        oneSentenceSummary: 'user object can be null and is dereferenced',
        suggestionContent: 'user object can be null and is dereferenced here',
    });
    const distinctX = () => ({
        relevantFile: 'src/a.ts',
        relevantLinesStart: 1,
        relevantLinesEnd: 2,
        label: 'security',
        severity: 'high',
        oneSentenceSummary: 'off by one error in the pagination loop',
        suggestionContent: 'the pagination loop iterates one element too far',
    });
    const distinctY = () => ({
        relevantFile: 'src/b.ts',
        relevantLinesStart: 40,
        relevantLinesEnd: 41,
        label: 'security',
        severity: 'critical',
        oneSentenceSummary: 'sql query built via string concatenation',
        suggestionContent: 'concatenating user input into the sql string',
    });

    let runSpy: jest.SpyInstance;
    afterEach(() => {
        runSpy?.mockRestore();
        jest.clearAllMocks();
    });

    it('keeps one of two duplicate findings', async () => {
        runSpy = jest.spyOn(LLM, 'run').mockResolvedValue({
            groups: [{ keep: 0, duplicates: [1] }],
            unique: [],
        } as any);

        const out = await deduplicateFindings(
            makeDeps(),
            [dupA(), dupA()],
            7,
            slot,
            telemetryMeta,
        );

        expect(out.suggestions).toHaveLength(1);
        expect(out.trace.status).toBe('success');
        expect(out.trace.removedCount).toBe(1);
        expect(out.trace.groups?.[0].duplicates).toHaveLength(1);
        expect(runSpy).toHaveBeenCalledTimes(1);
        expect(runSpy.mock.calls[0][0]).toMatchObject({
            byokConfig: slot,
            runName: 'code-review-dedup',
        });
        expect(logger.log).toHaveBeenCalledWith(
            expect.objectContaining({ context: 'SecurityScan' }),
        );
    });

    it('keeps distinct findings', async () => {
        runSpy = jest.spyOn(LLM, 'run').mockResolvedValue({
            groups: [],
            unique: [0, 1],
        } as any);

        const out = await deduplicateFindings(
            makeDeps(),
            [distinctX(), distinctY()],
            7,
            slot,
            telemetryMeta,
        );

        expect(out.suggestions).toHaveLength(2);
        expect(out.trace.status).toBe('success');
        expect(out.trace.removedCount).toBe(0);
    });

    it('asks the tiebreak when the model merges findings that do not read alike', async () => {
        runSpy = jest
            .spyOn(LLM, 'run')
            .mockResolvedValueOnce({
                groups: [{ keep: 0, duplicates: [1] }],
                unique: [],
            } as any)
            .mockResolvedValueOnce({ sameBug: false } as any);

        const out = await deduplicateFindings(
            makeDeps(),
            [distinctX(), distinctY()],
            7,
            slot,
            telemetryMeta,
        );

        expect(buildPlatformEmbedder).toHaveBeenCalledTimes(1);
        expect(runSpy).toHaveBeenCalledTimes(2);
        expect(runSpy.mock.calls[1][0]).toMatchObject({
            runName: 'dedup-tiebreak',
        });
        expect(out.suggestions).toHaveLength(2);
        expect(out.trace.removedCount).toBe(0);
    });

    it('never embeds on the platform key when the caller turns it off, and asks the BYOK tiebreak', async () => {
        // A platform key is configured: only the option keeps findings off it.
        (buildPlatformEmbedder as jest.Mock).mockReturnValue({} as any);
        runSpy = jest
            .spyOn(LLM, 'run')
            .mockResolvedValueOnce({
                groups: [{ keep: 0, duplicates: [1] }],
                unique: [],
            } as any)
            .mockResolvedValueOnce({ sameBug: false } as any);

        const out = await deduplicateFindings(
            createFindingDedupDeps({
                logger: logger as any,
                context: 'SecurityScan',
                platformEmbeddings: false,
            }),
            [distinctX(), distinctY()],
            7,
            slot,
            telemetryMeta,
        );
        (buildPlatformEmbedder as jest.Mock).mockReturnValue(null);

        expect(buildPlatformEmbedder).not.toHaveBeenCalled();
        expect(tracedEmbed).not.toHaveBeenCalled();
        expect(runSpy.mock.calls[1][0]).toMatchObject({
            runName: 'dedup-tiebreak',
            byokConfig: slot,
        });
        expect(out.suggestions).toHaveLength(2);
    });

    it('logs an embedding outage with the review it happened in', async () => {
        (buildPlatformEmbedder as jest.Mock).mockReturnValueOnce({} as any);
        (tracedEmbed as jest.Mock).mockRejectedValue(new Error('embeddings down'));
        runSpy = jest
            .spyOn(LLM, 'run')
            .mockResolvedValueOnce({
                groups: [{ keep: 0, duplicates: [1] }],
                unique: [],
            } as any)
            .mockResolvedValueOnce({ sameBug: false } as any);

        await deduplicateFindings(
            makeDeps(),
            [distinctX(), distinctY()],
            7,
            slot,
            telemetryMeta,
        );

        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining('embedding unavailable'),
                metadata: {
                    prNumber: 7,
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
            }),
        );
    });

    it('skips a single finding without calling the model', async () => {
        runSpy = jest.spyOn(LLM, 'run');

        const out = await deduplicateFindings(
            makeDeps(),
            [dupA()],
            7,
            slot,
            telemetryMeta,
        );

        expect(out.suggestions).toHaveLength(1);
        expect(out.trace.status).toBe('skipped');
        expect(out.trace.unique).toHaveLength(1);
        expect(runSpy).not.toHaveBeenCalled();
    });

    it('keeps everything when no model is available', async () => {
        runSpy = jest.spyOn(LLM, 'run');

        const out = await deduplicateFindings(
            makeDeps(),
            [dupA(), dupA()],
            7,
            undefined,
            telemetryMeta,
        );

        expect(out.suggestions).toHaveLength(2);
        expect(out.trace.status).toBe('skipped');
        expect(runSpy).not.toHaveBeenCalled();
    });
});
