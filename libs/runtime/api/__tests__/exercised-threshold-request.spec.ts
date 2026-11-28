import { RuntimeRunRequestedSchema } from '@libs/runtime/run/run-messages';

import { RuntimeRunRequestBuilder } from '../application/run-request-builder.service';
import type { PullRequestHead, RuntimeSettingsStore } from '../domain/ports';
import { BASE_SHA, ORG, REPO, SHA, TEAM, clock, config } from './fixtures';

// A Run is judged by the exercised-lines threshold its org had when the Run
// was asked: the product puts it in the Run request. An org that set none
// sends nothing, and the worker's RUNTIME_EXERCISED_LINES_THRESHOLD_PERCENT
// applies (docs/runtime/exercised-lines.md §7).

describe("the Run request carries the org's exercised-lines threshold", () => {
    const env = { environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop' };
    const head: PullRequestHead = { headSha: SHA, baseSha: BASE_SHA, fork: false };
    const builder = (org: Awaited<ReturnType<RuntimeSettingsStore['getOrganization']>>) => {
        const asked: string[] = [];
        const settings: Pick<RuntimeSettingsStore, 'getOrganization'> = {
            getOrganization: async (organizationId) => {
                asked.push(organizationId);
                return org;
            },
        };
        const b = new RuntimeRunRequestBuilder(
            { getPullRequestDiff: async () => ({ files: [], truncated: false }) } as any,
            { issue: async () => 'fixture-token' },
            { get: async () => ({ ...env, imageId: 'image-1', expose: [] }) },
            config(),
            clock,
            undefined,
            settings,
        );
        return { b, asked };
    };

    it.each([0, 30, 100])("puts the org's %i% in the request", async (percent) => {
        const { b, asked } = builder({ tokenBudgetPerDay: null, exercisedLinesThresholdPercent: percent });
        const requested = await b.build({ env, prNumber: 7, head, trigger: 'pull_request' });
        expect(requested.exercisedLinesThresholdPercent).toBe(percent);
        expect(asked).toEqual([ORG]);
        expect(RuntimeRunRequestedSchema.safeParse(requested).success).toBe(true);
    });

    it.each([null, { tokenBudgetPerDay: 5_000, exercisedLinesThresholdPercent: null }, { tokenBudgetPerDay: 5_000 }])(
        'sends no threshold when the org set none (%j), so the worker default applies',
        async (org) => {
            const requested = await builder(org).b.build({ env, prNumber: 7, head, trigger: 'pull_request' });
            expect(requested).not.toHaveProperty('exercisedLinesThresholdPercent');
        },
    );
});

// The org's fallback for a partly tested check (owner decision of 2026-11-18)
// travels the same way: a Run already asked keeps it. The default blocks, so
// only the neutral fallback is sent.
describe("the Run request carries the org's partly tested check", () => {
    const env = { environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop' };
    const head: PullRequestHead = { headSha: SHA, baseSha: BASE_SHA, fork: false };
    const build = (org: Awaited<ReturnType<RuntimeSettingsStore['getOrganization']>>) =>
        new RuntimeRunRequestBuilder(
            { getPullRequestDiff: async () => ({ files: [], truncated: false }) } as any,
            { issue: async () => 'fixture-token' },
            { get: async () => ({ ...env, imageId: 'image-1', expose: [] }) },
            config(),
            clock,
            undefined,
            { getOrganization: async () => org },
        ).build({ env, prNumber: 7, head, trigger: 'pull_request' });

    it("sends the org's neutral fallback", async () => {
        const requested = await build({ tokenBudgetPerDay: null, partlyTestedCheck: 'neutral' });
        expect(requested.partlyTestedCheck).toBe('neutral');
        expect(RuntimeRunRequestedSchema.safeParse(requested).success).toBe(true);
    });

    it.each([null, { tokenBudgetPerDay: null }, { tokenBudgetPerDay: null, partlyTestedCheck: 'action_required' as const }, { tokenBudgetPerDay: null, partlyTestedCheck: null }])(
        'sends nothing for the default (%j), so the check needs action',
        async (org) => {
            expect(await build(org)).not.toHaveProperty('partlyTestedCheck');
        },
    );
});
