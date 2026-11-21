import { RuntimeRunRequestedSchema } from '@libs/runtime/run/run-messages';

import { RuntimeRunRequestBuilder } from '../application/run-request-builder.service';
import type { PullRequestHead, RuntimeLinkedTasksReader } from '../domain/ports';
import { LinkedTasksAdapter } from '../infrastructure/linked-tasks.adapter';
import { BASE_SHA, ORG, REPO, SHA, TEAM, clock, config } from './fixtures';

// The product sends the tasks a PR links in the Run request: the intent author
// reads what they say the change does. Reading them never holds up the Run: a
// tracker that fails or is slow leaves the request without them.

describe('the product sends the tasks the PR links in the Run request', () => {
    const env = { environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop' };
    const head: PullRequestHead = { headSha: SHA, baseSha: BASE_SHA, fork: false, title: 'feat: coupons (SHOP-12)', headBranch: 'shop-12-coupons', description: 'Closes #4' };
    const builder = (reader?: RuntimeLinkedTasksReader) =>
        new RuntimeRunRequestBuilder(
            { getPullRequestDiff: async () => ({ files: [], truncated: false }) } as any,
            { issue: async () => 'fixture-token' },
            { get: async () => ({ ...env, imageId: 'image-1', expose: [] }) },
            config(),
            clock,
            undefined,
            undefined,
            undefined,
            reader,
        );

    it('puts the tasks the reader found in the request, read from the title, branch and description', async () => {
        const seen: unknown[] = [];
        const reader: RuntimeLinkedTasksReader = {
            read: async (input) => {
                seen.push(input);
                return [{ source: 'jira', id: 'SHOP-12', title: 'Coupons', body: 'SAVE20 takes 20% off; charge equals total.' }];
            },
        };
        const requested = await builder(reader).build({ env, prNumber: 7, head, trigger: 'pull_request' });
        expect(requested.pullRequest.linkedTasks).toEqual([{ source: 'jira', id: 'SHOP-12', title: 'Coupons', body: 'SAVE20 takes 20% off; charge equals total.' }]);
        expect(seen).toEqual([expect.objectContaining({ organizationId: ORG, teamId: TEAM, repositoryName: 'acme/shop', title: head.title, headBranch: head.headBranch, description: head.description })]);
        expect(RuntimeRunRequestedSchema.safeParse(requested).success).toBe(true);
    });

    it('builds the Run without tasks when the reader fails', async () => {
        const requested = await builder({ read: async () => Promise.reject(new Error('tracker down')) }).build({ env, prNumber: 7, head, trigger: 'pull_request' });
        expect(requested.pullRequest).not.toHaveProperty('linkedTasks');
    });

    it('builds the Run without tasks when the reader is slower than its budget', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        try {
            const pending = builder({ read: () => new Promise(() => undefined) }).build({ env, prNumber: 7, head, trigger: 'pull_request' });
            await jest.advanceTimersByTimeAsync(30_000);
            expect((await pending).pullRequest).not.toHaveProperty('linkedTasks');
        } finally {
            jest.useRealTimers();
        }
    });

    it('sends none when the reader found none, or there is no reader', async () => {
        expect((await builder({ read: async () => [] }).build({ env, prNumber: 7, head, trigger: 'pull_request' })).pullRequest).not.toHaveProperty('linkedTasks');
        expect((await builder().build({ env, prNumber: 7, head, trigger: 'pull_request' })).pullRequest).not.toHaveProperty('linkedTasks');
    });
});

describe('the linked tasks reader', () => {
    const input = { organizationId: 'o', teamId: 't', repositoryName: 'acme/shop', title: 'feat: coupons (SHOP-12)', headBranch: 'x', description: 'body' };

    it('keeps at most three tasks, their text cut to the bound, and closes every tracker', async () => {
        const closed: string[] = [];
        const adapter = new LinkedTasksAdapter({
            connections: async () => [{} as any],
            trackers: () => [{ name: 'jira', close: async () => void closed.push('jira') } as any],
            resolve: async () => ({
                kind: 'found',
                attempts: [],
                tasks: [1, 2, 3, 4].map((n) => ({ task: { tracker: 'jira', id: `SHOP-${n}`, title: `T${n}`, description: 'd'.repeat(20_000), acceptanceCriteria: ['a'] } })),
            }),
        });
        const tasks = await adapter.read(input);
        expect(tasks.map((t) => t.id)).toEqual(['SHOP-1', 'SHOP-2', 'SHOP-3']);
        expect(tasks[0].body.length).toBe(16_384);
        expect(closed).toEqual(['jira']);
    });

    it('joins the description and the acceptance criteria into the body', async () => {
        const adapter = new LinkedTasksAdapter({
            connections: async () => [{} as any],
            trackers: () => [{ name: 'linear', close: async () => undefined } as any],
            resolve: async () => ({ kind: 'found', attempts: [], tasks: [{ task: { tracker: 'linear', id: 'ENG-1', description: 'Coupons.', acceptanceCriteria: ['charge equals total', 'unknown coupon is 400'] } }] }),
        });
        expect(await adapter.read(input)).toEqual([{ source: 'linear', id: 'ENG-1', body: 'Coupons.\n\nAcceptance criteria:\n- charge equals total\n- unknown coupon is 400' }]);
    });

    it.each(['no_reference', 'no_tracker', 'not_found'])('finds none when the resolution is %s', async (kind) => {
        const adapter = new LinkedTasksAdapter({ connections: async () => [], trackers: () => [], resolve: async () => ({ kind, attempts: [] }) as any });
        expect(await adapter.read(input)).toEqual([]);
    });
});
