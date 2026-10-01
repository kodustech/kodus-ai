import { createHash } from 'crypto';

import { LLM } from '@libs/llm/llm';

import { PromptContextEngineService } from '../prompt/promptContextEngine.service';
import { ReferenceDetectorService } from '../reference-detector.service';
import { ContextReferenceDetectionService } from './context-reference-detection.service';

/**
 * Re-saving a Kody Rule whose text did not change.
 *
 * Production 2026-09-28: a centralized-config sync re-saves every valid rule
 * file on each run, and one org ran six syncs in ten minutes — 42 reference
 * detections, each one a model call on the org's own key, for 7 rules whose
 * text never changed.
 *
 * The model reads only the rule text, so its answer is reused while the text
 * is the same. Resolving the answer against the repository is NOT reused: a
 * moved or deleted file must still be caught on the next save.
 *
 * Real detection service + engine + detector; only the model call, the
 * repository lookup and the revision store are doubles.
 */
describe('reference detection — unchanged kody rule text', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    let llmRun: jest.SpyInstance;

    beforeEach(() => {
        llmRun = jest.spyOn(LLM, 'run');
    });

    afterEach(() => {
        llmRun.mockRestore();
    });

    /** Revision store double: the latest committed revision is what the next
     *  save reads back. */
    function makeRevisionStore() {
        const revisions: Array<{
            uuid: string;
            requirements: unknown[];
            metadata: Record<string, unknown>;
        }> = [];
        return {
            revisions,
            getLatestRevision: jest.fn(
                async () => revisions[revisions.length - 1],
            ),
            commitRevision: jest.fn(async (input: any) => {
                const uuid = `rev-${revisions.length + 1}`;
                revisions.push({
                    uuid,
                    requirements: input.requirements,
                    metadata: input.metadata,
                });
                return { pointer: { uuid } };
            }),
        };
    }

    function makeServices() {
        const store = makeRevisionStore();
        const engine = new PromptContextEngineService(
            {} as any,
            {} as any,
            new ReferenceDetectorService(),
        );
        const resolve = jest
            .spyOn(engine as any, 'searchFilesInRepository')
            .mockImplementation(async (detected: any) => ({
                references: detected.map((d: any) => ({
                    filePath: d.filePath,
                    originalText: d.originalText,
                    repositoryName: 'app',
                    repositoryId: 'repo-1',
                })),
                notFoundDetails: [],
            }));
        const service = new ContextReferenceDetectionService(
            engine,
            store as any,
        );
        return { service, store, resolve };
    }

    const save = (service: ContextReferenceDetectionService, text: string) =>
        service.detectAndSaveReferences({
            entityType: 'kodyRule',
            entityId: 'rule-1',
            repositoryId: 'repo-1',
            repositoryName: 'app',
            organizationAndTeamData,
            fields: [
                {
                    fieldId: 'rule',
                    path: ['rule'],
                    sourceType: 'kody_rule',
                    text,
                },
            ],
        } as any);

    describe('a rule that references no file', () => {
        const TEXT = 'Every defensive branch needs a test';

        it('asks the model once, then reuses the answer', async () => {
            llmRun.mockResolvedValue('[]');
            const { service } = makeServices();

            await save(service, TEXT);
            await save(service, TEXT);

            expect(llmRun).toHaveBeenCalledTimes(1);
        });

        it('stores the answer on the first save', async () => {
            llmRun.mockResolvedValue('[]');
            const { service, store } = makeServices();

            await save(service, TEXT);

            expect(store.commitRevision).toHaveBeenCalledTimes(1);
            expect(
                Object.values(
                    store.revisions[0].metadata.referenceDetections as object,
                ),
            ).toEqual([[]]);
        });

        it('commits no new revision when nothing changed', async () => {
            llmRun.mockResolvedValue('[]');
            const { service, store } = makeServices();

            const first = await save(service, TEXT);
            const second = await save(service, TEXT);

            expect(store.commitRevision).toHaveBeenCalledTimes(1);
            expect(second).toBe(first);
        });

        it('asks the model again when the text changed', async () => {
            llmRun.mockResolvedValue('[]');
            const { service } = makeServices();

            await save(service, TEXT);
            await save(service, `${TEXT}, including error paths`);

            expect(llmRun).toHaveBeenCalledTimes(2);
        });

        it('does not reuse an answer the model never gave (unparseable reply)', async () => {
            llmRun.mockResolvedValue('I could not find any references.');
            const { service } = makeServices();

            await save(service, TEXT);
            await save(service, TEXT);

            expect(llmRun).toHaveBeenCalledTimes(2);
        });
    });

    describe('a rule that references a file', () => {
        const TEXT = 'Endpoints must follow the contract in docs/api.md';
        const ANSWER = JSON.stringify([
            { filePath: 'docs/api.md', originalText: 'docs/api.md' },
        ]);

        it('reuses the answer but resolves the file against the repository every time', async () => {
            llmRun.mockResolvedValue(ANSWER);
            const { service, resolve } = makeServices();

            await save(service, TEXT);
            await save(service, TEXT);

            expect(llmRun).toHaveBeenCalledTimes(1);
            expect(resolve).toHaveBeenCalledTimes(2);
            expect(resolve.mock.calls[1][0]).toEqual([
                { filePath: 'docs/api.md', originalText: 'docs/api.md' },
            ]);
        });

        it('keeps committing so the resolved files stay current', async () => {
            llmRun.mockResolvedValue(ANSWER);
            const { service, store } = makeServices();

            await save(service, TEXT);
            await save(service, TEXT);

            expect(store.commitRevision).toHaveBeenCalledTimes(2);
            expect(store.revisions[1].metadata.referenceDetections).toEqual(
                store.revisions[0].metadata.referenceDetections,
            );
        });
    });

    it('ignores a stored cache slot that is not a map of arrays', async () => {
        llmRun.mockResolvedValue('[]');
        const { service, store } = makeServices();
        store.revisions.push({
            uuid: 'rev-legacy',
            requirements: [],
            metadata: { referenceDetections: ['not', 'a', 'map'] },
        });

        await save(service, 'Every defensive branch needs a test');

        expect(llmRun).toHaveBeenCalledTimes(1);
    });

    describe('the id handed back to the rule', () => {
        // Every Kody Rule runs detection. A rule holding an id is one the
        // review loads references for — and warns about when none resolve.
        it('gives a rule that references nothing no id, though its answer is kept', async () => {
            llmRun.mockResolvedValue('[]');
            const { service, store } = makeServices();

            const first = await save(
                service,
                'Every defensive branch needs a test',
            );
            const second = await save(
                service,
                'Every defensive branch needs a test',
            );

            expect(first).toBeUndefined();
            expect(second).toBeUndefined();
            expect(store.commitRevision).toHaveBeenCalledTimes(1);
        });

        it('gives no id when the text changes and still references nothing', async () => {
            llmRun.mockResolvedValue('[]');
            const { service, store } = makeServices();

            await save(service, 'Every defensive branch needs a test');
            const id = await save(service, 'Every guard clause needs a test');

            expect(id).toBeUndefined();
            expect(store.commitRevision).toHaveBeenCalledTimes(2);
        });

        it('returns the new id when the references are gone, so the rule stops pointing at them', async () => {
            llmRun.mockResolvedValue('[]');
            const { service, store } = makeServices();
            store.revisions.push({
                uuid: 'rev-0',
                requirements: [{ id: 'req-1' }],
                metadata: { syncErrorsCount: 0 },
            });

            const id = await save(
                service,
                'Every defensive branch needs a test',
            );

            expect(id).toBe('rev-2');
        });

        it('returns the new id when it clears sync errors, so the rule stops showing them', async () => {
            llmRun.mockResolvedValue('[]');
            const { service, store } = makeServices();
            store.revisions.push({
                uuid: 'rev-0',
                requirements: [],
                metadata: { syncErrorsCount: 2 },
            });

            const id = await save(
                service,
                'Every defensive branch needs a test',
            );

            expect(id).toBe('rev-2');
        });

        it('returns the id of a revision that holds references', async () => {
            llmRun.mockResolvedValue(
                JSON.stringify([
                    {
                        filePath: 'docs/errors.md',
                        originalText: '@file:docs/errors.md',
                    },
                ]),
            );
            const { service } = makeServices();

            const id = await save(
                service,
                'Follow the conventions in @file:docs/errors.md',
            );

            expect(id).toBe('rev-1');
        });
    });

    describe('save-path edges', () => {
        it('saves nothing when there is no usable answer and no earlier revision', async () => {
            llmRun.mockResolvedValue('I could not find any references.');
            const { service, store } = makeServices();

            const id = await save(
                service,
                'Every defensive branch needs a test',
            );

            expect(id).toBeUndefined();
            expect(store.commitRevision).not.toHaveBeenCalled();
        });

        it('leaves no cache slot on a revision saved without a usable answer', async () => {
            llmRun.mockResolvedValue('I could not find any references.');
            const { service, store } = makeServices();
            store.revisions.push({
                uuid: 'rev-0',
                requirements: [],
                metadata: { syncErrorsCount: 1 },
            });

            await save(service, 'Every defensive branch needs a test');

            expect(store.commitRevision).toHaveBeenCalledTimes(1);
            expect(store.revisions[1].metadata).not.toHaveProperty(
                'referenceDetections',
            );
        });

        it('treats surrounding whitespace as the same text', async () => {
            llmRun.mockResolvedValue('[]');
            const { service, store } = makeServices();

            await save(service, 'Every defensive branch needs a test');
            await save(service, '  Every defensive branch needs a test \n');

            expect(llmRun).toHaveBeenCalledTimes(1);
            expect(store.commitRevision).toHaveBeenCalledTimes(1);
        });

        it('commits nothing over a clean empty revision when no detection ran (no reference patterns)', async () => {
            // A code-review instruction with nothing that looks like a file
            // skips the model entirely: no answer to keep, no stale state to
            // clear, so another empty revision would only be noise.
            const { service, store } = makeServices();
            store.revisions.push({
                uuid: 'rev-0',
                requirements: [],
                metadata: { syncErrorsCount: 0 },
            });
            const saveConfig = (text: string) =>
                service.detectAndSaveReferences({
                    entityType: 'codeReviewConfig',
                    entityId: 'cfg-1',
                    repositoryId: 'repo-1',
                    repositoryName: 'app',
                    organizationAndTeamData,
                    fields: [
                        {
                            fieldId: 'summary',
                            path: ['summary'],
                            sourceType: 'custom_prompt',
                            text,
                        },
                    ],
                } as any);

            const first = await saveConfig('Be concise');
            const second = await saveConfig('Be concise and friendly');

            expect(llmRun).not.toHaveBeenCalled();
            expect(store.commitRevision).not.toHaveBeenCalled();
            expect(first).toBeUndefined();
            expect(second).toBeUndefined();
        });

        it('recommits over a revision that carried sync errors, to clear them', async () => {
            llmRun.mockResolvedValue('[]');
            const { service, store } = makeServices();
            await save(service, 'Every defensive branch needs a test');
            store.revisions[0].metadata.syncErrorsCount = 2;

            await save(service, 'Every defensive branch needs a test');

            expect(store.commitRevision).toHaveBeenCalledTimes(2);
        });
    });

    describe('isSameEmptyRevision', () => {
        const svc = new ContextReferenceDetectionService(
            {} as any,
            {} as any,
        ) as any;
        const HASH = 'h1';
        const detections = {
            fpA: [],
            fpB: [{ filePath: 'a.md', originalText: 'a' }],
        };
        const revision = (
            over: Record<string, unknown> = {},
            requirements: unknown[] | undefined = [],
        ) => ({
            requirements,
            metadata: {
                entityHash: HASH,
                syncErrorsCount: 0,
                referenceDetections: detections,
                ...over,
            },
        });

        it('is true for the same hash, no requirements, no errors, same answers', () => {
            expect(svc.isSameEmptyRevision(revision(), HASH, detections)).toBe(
                true,
            );
        });

        it('compares answer maps regardless of key order', () => {
            const reordered = {
                fpB: [{ originalText: 'a', filePath: 'a.md' }],
                fpA: [],
            };
            expect(svc.isSameEmptyRevision(revision(), HASH, reordered)).toBe(
                true,
            );
        });

        it('is false when an answer differs', () => {
            expect(
                svc.isSameEmptyRevision(revision(), HASH, {
                    ...detections,
                    fpA: [{ filePath: 'x' }],
                }),
            ).toBe(false);
        });

        it('is false when the stored revision has requirements', () => {
            expect(
                svc.isSameEmptyRevision(
                    revision({}, [{ id: 'r' }]),
                    HASH,
                    detections,
                ),
            ).toBe(false);
        });

        it('reads missing requirements as none', () => {
            const { requirements: _none, ...withoutRequirements } = revision();
            expect(
                svc.isSameEmptyRevision(withoutRequirements, HASH, detections),
            ).toBe(true);
        });

        it('is false when the text hash differs', () => {
            expect(svc.isSameEmptyRevision(revision(), 'h2', detections)).toBe(
                false,
            );
        });

        it('is false when the stored revision carried sync errors', () => {
            expect(
                svc.isSameEmptyRevision(
                    revision({ syncErrorsCount: 1 }),
                    HASH,
                    detections,
                ),
            ).toBe(false);
        });

        it('reads a revision without a cache slot as having no answers', () => {
            expect(
                svc.isSameEmptyRevision(
                    revision({ referenceDetections: undefined }),
                    HASH,
                    {},
                ),
            ).toBe(true);
        });

        it('is false for a revision without metadata', () => {
            expect(
                svc.isSameEmptyRevision({ requirements: [] }, HASH, {}),
            ).toBe(false);
        });
    });

    describe('readDetectionCache', () => {
        const svc = new ContextReferenceDetectionService(
            {} as any,
            {} as any,
        ) as any;

        it.each([
            ['no revision', undefined],
            ['no metadata', {}],
            ['no slot', { metadata: {} }],
            ['a string slot', { metadata: { referenceDetections: 'x' } }],
            ['an array slot', { metadata: { referenceDetections: [[]] } }],
        ])('is empty for %s', (_label, revision) => {
            expect(svc.readDetectionCache(revision)).toEqual({});
        });

        it('keeps only the entries whose answer is an array', () => {
            expect(
                svc.readDetectionCache({
                    metadata: {
                        referenceDetections: {
                            good: [{ filePath: 'a' }],
                            bad: 'x',
                        },
                    },
                }),
            ).toEqual({ good: [{ filePath: 'a' }] });
        });
    });

    it('fingerprint pins the exact inputs of the model request', () => {
        const { prompt_kodyrules_detect_references_system } =
            jest.requireActual(
                '@libs/common/utils/prompts/kodyRulesExternalReferences',
            );
        const expected = createHash('sha256')
            .update(
                [
                    prompt_kodyrules_detect_references_system(),
                    'rule',
                    'rule',
                    'Follow docs/api.md',
                ].join('\n\u0000\n'),
            )
            .digest('hex');
        expect(
            new ReferenceDetectorService().detectionFingerprint({
                promptText: 'Follow docs/api.md',
                detectionMode: 'rule',
                context: 'rule',
            }),
        ).toBe(expected);
    });

    it('fingerprint uses the prompt-mode system prompt outside rule mode', () => {
        const { prompt_detect_external_references_system } = jest.requireActual(
            '@libs/common/utils/prompts/externalReferences',
        );
        const expected = createHash('sha256')
            .update(
                [
                    prompt_detect_external_references_system(),
                    '',
                    '',
                    'See README.md',
                ].join('\n\u0000\n'),
            )
            .digest('hex');
        expect(
            new ReferenceDetectorService().detectionFingerprint({
                promptText: 'See README.md',
            }),
        ).toBe(expected);
    });

    it('the engine still detects when no cache is passed (existing callers)', async () => {
        llmRun.mockResolvedValue('[]');
        const engine = new PromptContextEngineService(
            {} as any,
            {} as any,
            new ReferenceDetectorService(),
        );

        const out = await engine.detectAndResolveReferences({
            requirementId: 'r',
            promptText: 'Every defensive branch needs a test',
            path: ['rule'],
            sourceType: 'kody_rule' as any,
            repositoryId: 'repo-1',
            repositoryName: 'app',
            organizationAndTeamData,
            context: 'rule',
            detectionMode: 'rule',
        });

        expect(llmRun).toHaveBeenCalledTimes(1);
        expect(out.detection?.references).toEqual([]);
        expect(out.detection?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });
});
