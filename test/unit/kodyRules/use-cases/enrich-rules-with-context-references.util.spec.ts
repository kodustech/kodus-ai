import { enrichRulesWithContextReferences } from '@libs/kodyRules/application/use-cases/utils/enrich-rules-with-context-references.util';

/**
 * The enrich util used to issue one findById per rule (N+1). It now
 * batch-loads every referenced context in a single findByIds call. These
 * tests pin that behaviour and the pending/failed status semantics.
 */
describe('enrichRulesWithContextReferences', () => {
    const logger = { warn: jest.fn() } as any;

    const makeRef = (uuid: string) => ({
        uuid,
        processingStatus: 'completed',
        lastProcessedAt: undefined,
        requirements: [],
    });

    beforeEach(() => jest.clearAllMocks());

    it('resolves all references in a single batched query, de-duping ids', async () => {
        const findByIds = jest
            .fn()
            .mockResolvedValue([makeRef('ctx-1'), makeRef('ctx-2')]);
        const service = { findById: jest.fn(), findByIds } as any;

        const rules = [
            { uuid: 'r1', contextReferenceId: 'ctx-1' },
            { uuid: 'r2', contextReferenceId: 'ctx-2' },
            // duplicate id — must not produce a second lookup
            { uuid: 'r3', contextReferenceId: 'ctx-1' },
            // no reference — must be skipped entirely
            { uuid: 'r4' },
        ];

        const result = await enrichRulesWithContextReferences(
            rules,
            service,
            logger,
        );

        // Exactly one batch call, never the per-rule findById.
        expect(findByIds).toHaveBeenCalledTimes(1);
        expect(service.findById).not.toHaveBeenCalled();
        // Called with the de-duped id set.
        const [idsArg] = findByIds.mock.calls[0];
        expect([...idsArg].sort()).toEqual(['ctx-1', 'ctx-2']);

        // Resolved rules carry the ref status; the duplicate resolves too.
        expect(result[0].referenceProcessingStatus).toBe('completed');
        expect(result[2].referenceProcessingStatus).toBe('completed');
        // The reference-less rule gets a null status.
        expect(result[3].referenceProcessingStatus).toBeNull();
    });

    it('marks rules whose reference is missing as "pending"', async () => {
        const service = {
            findById: jest.fn(),
            findByIds: jest.fn().mockResolvedValue([]), // none found
        } as any;

        const result = await enrichRulesWithContextReferences(
            [{ uuid: 'r1', contextReferenceId: 'ctx-missing' }],
            service,
            logger,
        );

        expect(result[0].referenceProcessingStatus).toBe('pending');
    });

    it('marks rules as "failed" when the batch query throws', async () => {
        const service = {
            findById: jest.fn(),
            findByIds: jest.fn().mockRejectedValue(new Error('db down')),
        } as any;

        const result = await enrichRulesWithContextReferences(
            [{ uuid: 'r1', contextReferenceId: 'ctx-1' }],
            service,
            logger,
        );

        expect(result[0].referenceProcessingStatus).toBe('failed');
        expect(logger.warn).toHaveBeenCalled();
    });

    it('never queries when no rule references a context', async () => {
        const findByIds = jest.fn();
        const service = { findById: jest.fn(), findByIds } as any;

        await enrichRulesWithContextReferences(
            [{ uuid: 'r1' }, { uuid: 'r2' }],
            service,
            logger,
        );

        expect(findByIds).not.toHaveBeenCalled();
    });
});
