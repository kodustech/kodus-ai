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
});
