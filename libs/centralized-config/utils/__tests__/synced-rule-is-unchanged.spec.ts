import {
    KodyRuleCentralizedStatus,
    KodyRulesStatus,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import { syncedRuleIsUnchanged } from '../synced-rule-is-unchanged';

// What the sync builds from a rule file (see synchronizeKodyRules).
const incoming = () => ({
    uuid: 'rule-1',
    title: 'No silent catch',
    rule: 'Do not swallow errors.',
    severity: 'high',
    examples: [{ snippet: 'catch {}', isCorrect: false }],
    path: '**/*',
    scope: 'file',
    inheritance: { inheritable: true, include: [], exclude: [] },
    type: 'standard',
    status: KodyRulesStatus.ACTIVE,
    repositoryId: 'repo-1',
    directoryId: undefined,
    centralizedConfig: {
        path: 'repo-1/.kody-rules/review/no-silent-catch.yml',
        status: KodyRuleCentralizedStatus.SYNCED,
    },
    origin: 'repo_file_sync',
});

// The same rule as Mongo hands it back: other key order, fields the sync
// does not own, no `directoryId` key at all.
const stored = () => ({
    centralizedConfig: {
        status: KodyRuleCentralizedStatus.SYNCED,
        path: 'repo-1/.kody-rules/review/no-silent-catch.yml',
    },
    uuid: 'rule-1',
    origin: 'repo_file_sync',
    repositoryId: 'repo-1',
    status: KodyRulesStatus.ACTIVE,
    type: 'standard',
    inheritance: { exclude: [], include: [], inheritable: true },
    scope: 'file',
    path: '**/*',
    examples: [{ isCorrect: false, snippet: 'catch {}' }],
    severity: 'high',
    rule: 'Do not swallow errors.',
    title: 'No silent catch',
    createdAt: new Date('2026-11-01'),
    updatedAt: new Date('2026-11-17'),
    detector: { kind: 'regex' },
    summary: 'short',
});

describe('syncedRuleIsUnchanged', () => {
    it('is unchanged when the file yields the rule already stored', () => {
        expect(syncedRuleIsUnchanged(stored() as any, incoming() as any)).toBe(
            true,
        );
    });

    it.each([
        ['the rule text', { rule: 'Do not swallow errors, ever.' }],
        ['the title', { title: 'Never swallow' }],
        ['the severity', { severity: 'critical' }],
        [
            'an example',
            { examples: [{ snippet: 'catch {}', isCorrect: true }] },
        ],
        [
            'the inheritance',
            { inheritance: { inheritable: false, include: [], exclude: [] } },
        ],
        ['the scope path', { path: 'src/**' }],
        ['the directory', { directoryId: 'dir-1' }],
        ['the status (file disabled)', { status: KodyRulesStatus.PAUSED }],
        [
            'an extra example',
            {
                examples: [
                    { snippet: 'catch {}', isCorrect: false },
                    { snippet: 'catch (e) {}', isCorrect: false },
                ],
            },
        ],
        ['the examples, given as one object', { examples: { snippet: 'x' } }],
        ['a number', { priority: 2 }],
        ['a date', { reviewedAt: new Date('2026-11-02T00:00:00Z') }],
    ])('is changed when %s differs', (_label, change) => {
        expect(
            syncedRuleIsUnchanged(
                stored() as any,
                {
                    ...incoming(),
                    ...change,
                } as any,
            ),
        ).toBe(false);
    });

    it('writes a stored rule the sync had marked deleted, so the file brings it back', () => {
        expect(
            syncedRuleIsUnchanged(
                { ...stored(), status: KodyRulesStatus.DELETED } as any,
                incoming() as any,
            ),
        ).toBe(false);
    });

    it('rewrites the centralized marker when another flow left it pending', () => {
        expect(
            syncedRuleIsUnchanged(
                {
                    ...stored(),
                    centralizedConfig: {
                        ...stored().centralizedConfig,
                        status: KodyRuleCentralizedStatus.PENDING_EDIT,
                    },
                } as any,
                incoming() as any,
            ),
        ).toBe(false);
    });

    it('compares severity regardless of case, as the service stores it lowercased', () => {
        expect(
            syncedRuleIsUnchanged(
                stored() as any,
                {
                    ...incoming(),
                    severity: 'HIGH',
                } as any,
            ),
        ).toBe(true);
    });

    it('writes a legacy mixed-case severity so the write normalizes it', () => {
        expect(
            syncedRuleIsUnchanged(
                { ...stored(), severity: 'High' } as any,
                { ...incoming(), severity: 'high' } as any,
            ),
        ).toBe(false);
    });

    it('writes a rule the plan limit paused when the file asks for active, so a free slot lifts the lock', () => {
        expect(
            syncedRuleIsUnchanged(
                {
                    ...stored(),
                    status: KodyRulesStatus.PAUSED,
                    lockedByPlan: true,
                } as any,
                incoming() as any,
            ),
        ).toBe(false);
    });

    it('writes a plan-locked rule the file disables, so an upgrade does not turn it on', () => {
        expect(
            syncedRuleIsUnchanged(
                {
                    ...stored(),
                    status: KodyRulesStatus.PAUSED,
                    lockedByPlan: true,
                } as any,
                { ...incoming(), status: KodyRulesStatus.PAUSED } as any,
            ),
        ).toBe(false);
    });

    it('leaves alone a rule the file disables and that is already paused', () => {
        expect(
            syncedRuleIsUnchanged(
                {
                    ...stored(),
                    status: KodyRulesStatus.PAUSED,
                    lockedByPlan: false,
                } as any,
                { ...incoming(), status: KodyRulesStatus.PAUSED } as any,
            ),
        ).toBe(true);
    });

    it('writes a rule a user paused when the file asks for active', () => {
        expect(
            syncedRuleIsUnchanged(
                { ...stored(), status: KodyRulesStatus.PAUSED } as any,
                incoming() as any,
            ),
        ).toBe(false);
    });

    // Fields the file carries are compared by value, whatever their shape.
    describe('value comparison', () => {
        const withStored = (fields: Record<string, unknown>) => ({
            ...stored(),
            priority: 1,
            reviewedAt: new Date('2026-11-01T00:00:00Z'),
            ...fields,
        });
        const withIncoming = (fields: Record<string, unknown>) => ({
            ...incoming(),
            priority: 1,
            reviewedAt: new Date('2026-11-01T00:00:00Z'),
            ...fields,
        });

        it('treats a missing, undefined and null field as the same', () => {
            expect(
                syncedRuleIsUnchanged(
                    withStored({ directoryId: null }) as any,
                    withIncoming({ directoryId: undefined }) as any,
                ),
            ).toBe(true);
        });

        it('compares dates by instant, not by object', () => {
            expect(
                syncedRuleIsUnchanged(
                    withStored({}) as any,
                    withIncoming({
                        reviewedAt: '2026-11-01T00:00:00.000Z',
                    }) as any,
                ),
            ).toBe(true);
        });

        it.each([
            [
                'two different dates',
                { reviewedAt: new Date('2026-11-02T00:00:00Z') },
            ],
            ['two different numbers', { priority: 2 }],
            [
                'a list and an object with the same entries',
                {
                    examples: {
                        0: { snippet: 'catch {}', isCorrect: false },
                    },
                },
            ],
        ])('tells apart %s', (_label, change) => {
            expect(
                syncedRuleIsUnchanged(
                    withStored({}) as any,
                    withIncoming(change) as any,
                ),
            ).toBe(false);
        });

        it('leaves the uuid out: it is the key the rule was matched by', () => {
            expect(
                syncedRuleIsUnchanged(
                    withStored({}) as any,
                    withIncoming({ uuid: 'other-uuid' }) as any,
                ),
            ).toBe(true);
        });

        it('reads an absent severity as no severity', () => {
            const { severity: _ignored, ...withoutSeverity } = stored();
            expect(
                syncedRuleIsUnchanged(
                    { ...withoutSeverity, priority: 1 } as any,
                    {
                        ...incoming(),
                        severity: undefined,
                        priority: 1,
                    } as any,
                ),
            ).toBe(true);
        });
    });
});
