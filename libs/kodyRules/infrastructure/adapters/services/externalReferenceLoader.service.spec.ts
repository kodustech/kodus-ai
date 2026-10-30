import { ExternalReferenceLoaderService } from './externalReferenceLoader.service';

/** Build a buildContextPack result with one knowledge layer of {filePath,content}. */
const pack = (entries: Array<{ filePath: string; content: string }>) => ({
    pack: {
        layers: [{ metadata: { sourceType: 'knowledge' }, content: entries }],
    },
    augmentations: {},
});

const makeSvc = (buildContextPack: jest.Mock) =>
    new ExternalReferenceLoaderService({ buildContextPack } as any);

describe('ExternalReferenceLoaderService', () => {
    describe('loadReferences — content guard', () => {
        it('excludes empty and whitespace-only reference content', async () => {
            const buildContextPack = jest.fn().mockResolvedValue(
                pack([
                    { filePath: 'a.md', content: '   \n\t ' },
                    { filePath: 'b.md', content: '' },
                    { filePath: 'c.md', content: 'real content' },
                ]),
            );
            const svc = makeSvc(buildContextPack);

            const { references } = await svc.loadReferences(
                { uuid: 'r1', contextReferenceId: 'ctx' } as any,
                {} as any,
            );

            expect(references.map((r) => r.filePath)).toEqual(['c.md']);
        });

        it('returns empty when the rule has no contextReferenceId (no network)', async () => {
            const buildContextPack = jest.fn();
            const svc = makeSvc(buildContextPack);

            const { references } = await svc.loadReferences(
                { uuid: 'r1' } as any,
                {} as any,
            );

            expect(references).toEqual([]);
            expect(buildContextPack).not.toHaveBeenCalled();
        });
    });

    describe('loadReferencesForRules', () => {
        it('maps resolved references by rule uuid and skips rules without a uuid', async () => {
            const buildContextPack = jest
                .fn()
                .mockImplementation(({ contextReferenceId }) =>
                    Promise.resolve(
                        pack([{ filePath: `${contextReferenceId}.md`, content: 'x' }]),
                    ),
                );
            const svc = makeSvc(buildContextPack);

            const { referencesMap } = await svc.loadReferencesForRules(
                [
                    { uuid: 'r1', contextReferenceId: 'c1' },
                    { uuid: 'r2', contextReferenceId: 'c2' },
                    { contextReferenceId: 'c3' }, // no uuid → skipped
                ] as any,
                {} as any,
            );

            expect([...referencesMap.keys()].sort()).toEqual(['r1', 'r2']);
            expect(buildContextPack).toHaveBeenCalledTimes(2);
        });

        it('degrades a single failing rule without dropping the others', async () => {
            const buildContextPack = jest
                .fn()
                .mockImplementation(({ contextReferenceId }) =>
                    contextReferenceId === 'bad'
                        ? Promise.reject(new Error('boom'))
                        : Promise.resolve(
                              pack([{ filePath: 'ok.md', content: 'y' }]),
                          ),
                );
            const svc = makeSvc(buildContextPack);

            const { referencesMap } = await svc.loadReferencesForRules(
                [
                    { uuid: 'good', contextReferenceId: 'ok' },
                    { uuid: 'bad', contextReferenceId: 'bad' },
                ] as any,
                {} as any,
            );

            expect(referencesMap.has('good')).toBe(true);
            expect(referencesMap.has('bad')).toBe(false);
        });

        it('runs the per-rule loads in parallel but caps concurrency', async () => {
            let inFlight = 0;
            let maxInFlight = 0;
            const buildContextPack = jest.fn().mockImplementation(async () => {
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise((r) => setTimeout(r, 5));
                inFlight--;
                return pack([{ filePath: 'x.md', content: 'x' }]);
            });
            const svc = makeSvc(buildContextPack);

            const rules = Array.from({ length: 12 }, (_, i) => ({
                uuid: `r${i}`,
                contextReferenceId: `c${i}`,
            }));

            await svc.loadReferencesForRules(rules as any, {} as any);

            expect(maxInFlight).toBeGreaterThan(1); // actually parallel
            expect(maxInFlight).toBeLessThanOrEqual(4); // but bounded
            expect(buildContextPack).toHaveBeenCalledTimes(12);
        });
    });
});
