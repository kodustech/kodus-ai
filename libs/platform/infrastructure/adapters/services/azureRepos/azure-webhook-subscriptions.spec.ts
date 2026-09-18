import { generateWebhookToken } from '@libs/common/utils/webhooks/webhookTokenCrypto';
import { AzureRepoSubscription } from '@libs/platform/domain/azure/entities/azureRepoExtras.type';

import { AzureReposService } from './azureRepos.service';

/**
 * Regression tests for issue #1956 — saving the Azure DevOps repository
 * selection exhausted the account's Azure rate limit.
 *
 * Measured against a real Azure DevOps organization before the fix: saving
 * 3 repositories issued 9 `ListSubscriptions` calls (3 per repository, one per
 * event type), each one an organization-wide listing costing ~1.75 of the
 * 200 TSTUs an account gets per sliding 5-minute window. Two of those three
 * repositories were already subscribed and still got 3 deletes + 3 creates
 * that left Azure in exactly the state it was already in. Azure responded by
 * delaying every request the service account made — code reviews included —
 * by about 20 seconds.
 *
 * These exercise the real `AzureReposService`, deliberately: the pre-existing
 * `test/unit/platform/services/azure-delete-webhook.spec.ts` reimplements
 * `deleteWebhook` inside the spec file, so it passes no matter what the
 * service does and catches no regression in it.
 *
 * What must keep holding, and why each one is here:
 *  - one listing per pass, never per repository per event (the bug);
 *  - a repository that is already subscribed costs zero writes (the churn);
 *  - a newly added repository still gets its 3 subscriptions (the risk that a
 *    skip-based fix skips too much);
 *  - a subscription whose token this instance cannot validate is still
 *    replaced, so rotating CODE_MANAGEMENT_SECRET keeps healing hooks the way
 *    delete-and-recreate used to;
 *  - exactly one subscription per repository/event, which is what the
 *    delete-then-create in 1657bf18e was introduced to guarantee;
 *  - concurrent saves (the web UI posts the selection in chunks of 50) run one
 *    pass, not overlapping ones that each create the same hooks;
 *  - `createWebhook` never rejects, because its caller fires it without
 *    awaiting and an orphaned rejection has already crashed the API process
 *    once on the Bitbucket adapter.
 */

const WEBHOOK_URL = 'https://webhook.kodus.test/azure-repos';

const EVENT_TYPES = [
    'git.pullrequest.created',
    'git.pullrequest.updated',
    'ms.vss-code.git-pullrequest-comment-event',
];

type Repo = { id: string; name: string; project: { id: string } };

const REPO_A: Repo = {
    id: 'repo-a',
    name: 'frontend-app',
    project: { id: 'project-1' },
};

const REPO_B: Repo = {
    id: 'repo-b',
    name: 'backend-api',
    project: { id: 'project-1' },
};

/**
 * The team whose subscriptions the fixtures mint, kept module-level because
 * the fixture helpers are and the team id is generated per test.
 */
let currentTeamId = '';

/**
 * Sentinel for a subscription minted before the team marker existed. It cannot
 * be `undefined`: that is what a defaulted parameter falls back on, so it would
 * silently produce a marked subscription instead of an unmarked one.
 */
const NO_TEAM = '';

/** The callback URL a subscription minted by `teamId` carries. */
function callbackUrl(teamId: string | undefined, token = generateWebhookToken()) {
    const base = `${WEBHOOK_URL}?token=${encodeURIComponent(token)}`;

    return teamId ? `${base}&team=${encodeURIComponent(teamId)}` : base;
}

/** A subscription shaped like the ones Kodus creates, with a valid token. */
function subscriptionFor(
    repo: Repo,
    eventType: string,
    overrides: Partial<AzureRepoSubscription> = {},
    teamId: string | undefined = currentTeamId,
): AzureRepoSubscription {
    return {
        id: `sub-${repo.id}-${eventType}`,
        eventType,
        publisherId: 'tfs',
        consumerId: 'webHooks',
        consumerActionId: 'httpRequest',
        publisherInputs: {
            projectId: repo.project.id,
            repository: repo.id,
        },
        consumerInputs: {
            url: callbackUrl(teamId),
        },
        ...overrides,
    } as AzureRepoSubscription;
}

/** Waits for a condition the service reaches asynchronously. */
async function waitFor(
    condition: () => boolean,
    timeoutMs = 1000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error('waitFor timed out');
        }
        await new Promise((resolve) => setImmediate(resolve));
    }
}

function allSubscriptionsFor(repos: Repo[]): AzureRepoSubscription[] {
    return repos.flatMap((repo) =>
        EVENT_TYPES.map((eventType) => subscriptionFor(repo, eventType)),
    );
}

describe('AzureReposService webhook subscriptions (issue #1956)', () => {
    let service: AzureReposService;
    let helper: {
        listSubscriptions: jest.Mock;
        listSubscriptionsByProject: jest.Mock;
        createSubscriptionForProject: jest.Mock;
        deleteWebhookById: jest.Mock;
    };
    let orgTeamSeq = 0;
    let orgTeam: { organizationId: string; teamId: string };

    beforeEach(() => {
        process.env.GLOBAL_AZURE_REPOS_CODE_MANAGEMENT_WEBHOOK = WEBHOOK_URL;

        // The single-flight bookkeeping is module-level, so every test gets a
        // fresh org/team key rather than relying on cleanup order.
        orgTeamSeq += 1;
        orgTeam = {
            organizationId: `org-${orgTeamSeq}`,
            teamId: `team-${orgTeamSeq}`,
        };
        currentTeamId = orgTeam.teamId;

        helper = {
            listSubscriptions: jest.fn().mockResolvedValue([]),
            listSubscriptionsByProject: jest.fn().mockResolvedValue([]),
            createSubscriptionForProject: jest
                .fn()
                .mockImplementation(async () => ({ id: 'created-sub' })),
            deleteWebhookById: jest.fn().mockResolvedValue(undefined),
        };

        service = new AzureReposService(
            {} as any, // integrationService
            {} as any, // integrationConfigService
            {} as any, // authIntegrationService
            helper as any,
            { get: jest.fn().mockReturnValue(WEBHOOK_URL) } as any,
            undefined, // mcpManagerService
        );

        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
            orgName: 'my-org',
            token: 'encrypted-pat',
            authMode: 'token',
        });
    });

    function withSelection(repos: Repo[]) {
        jest.spyOn(
            service as any,
            'findOneByOrganizationAndTeamDataAndConfigKey',
        ).mockResolvedValue(repos);
    }

    // ── the bug: listings must not scale with repositories × events ───────
    describe('listing cost', () => {
        it('lists the organization subscriptions once per pass, not once per repository per event', async () => {
            withSelection([REPO_A, REPO_B]);

            await service.createWebhook(orgTeam);

            // Before the fix this was 6: 2 repositories × 3 event types.
            expect(helper.listSubscriptions).toHaveBeenCalledTimes(1);
            expect(helper.listSubscriptions).toHaveBeenCalledWith({
                orgName: 'my-org',
                token: 'encrypted-pat',
            });
        });

        it('still lists once when the selection grows, so the cost does not scale with it', async () => {
            const manyRepos = Array.from({ length: 50 }, (_, i) => ({
                id: `repo-${i}`,
                name: `repo-${i}`,
                project: { id: 'project-1' },
            }));
            withSelection(manyRepos);

            await service.createWebhook(orgTeam);

            expect(helper.listSubscriptions).toHaveBeenCalledTimes(1);
            // 150 organization-wide listings before the fix.
            expect(helper.createSubscriptionForProject).toHaveBeenCalledTimes(
                150,
            );
        });
    });

    // ── the churn: an already-correct hook must cost nothing ──────────────
    describe('repositories that are already subscribed', () => {
        beforeEach(() => {
            withSelection([REPO_A, REPO_B]);
            helper.listSubscriptions.mockResolvedValue(
                allSubscriptionsFor([REPO_A, REPO_B]),
            );
        });

        it('writes nothing to Azure', async () => {
            await service.createWebhook(orgTeam);

            // Before the fix: 6 deletes + 6 creates that changed nothing.
            expect(helper.deleteWebhookById).not.toHaveBeenCalled();
            expect(helper.createSubscriptionForProject).not.toHaveBeenCalled();
        });

        it('costs exactly one Azure call in total', async () => {
            await service.createWebhook(orgTeam);

            const totalCalls =
                helper.listSubscriptions.mock.calls.length +
                helper.createSubscriptionForProject.mock.calls.length +
                helper.deleteWebhookById.mock.calls.length;

            expect(totalCalls).toBe(1);
        });
    });

    // ── the risk of a skip-based fix: it must not skip real work ──────────
    describe('repositories that still need subscribing', () => {
        it('creates all three event subscriptions for a repository with none', async () => {
            withSelection([REPO_A]);

            await service.createWebhook(orgTeam);

            expect(helper.createSubscriptionForProject).toHaveBeenCalledTimes(
                3,
            );

            const createdEvents = helper.createSubscriptionForProject.mock.calls
                .map((call) => call[0].subscriptionPayload.eventType)
                .sort();
            expect(createdEvents).toEqual([...EVENT_TYPES].sort());
        });

        it('subscribes only the newly added repository when the other is already covered', async () => {
            withSelection([REPO_A, REPO_B]);
            helper.listSubscriptions.mockResolvedValue(
                allSubscriptionsFor([REPO_A]),
            );

            await service.createWebhook(orgTeam);

            expect(helper.createSubscriptionForProject).toHaveBeenCalledTimes(
                3,
            );

            const createdRepos = new Set(
                helper.createSubscriptionForProject.mock.calls.map(
                    (call) => call[0].subscriptionPayload.publisherInputs.repository,
                ),
            );
            expect([...createdRepos]).toEqual([REPO_B.id]);
            expect(helper.deleteWebhookById).not.toHaveBeenCalled();
        });

        it('keeps the per-event resourceVersion Azure requires', async () => {
            withSelection([REPO_A]);

            await service.createWebhook(orgTeam);

            const versionByEvent = Object.fromEntries(
                helper.createSubscriptionForProject.mock.calls.map((call) => [
                    call[0].subscriptionPayload.eventType,
                    call[0].subscriptionPayload.resourceVersion,
                ]),
            );

            expect(versionByEvent).toEqual({
                'git.pullrequest.created': '1.0',
                'git.pullrequest.updated': '1.0',
                'ms.vss-code.git-pullrequest-comment-event': '2.0',
            });
        });
    });

    // ── the healing property delete-and-recreate used to provide ──────────
    describe('subscriptions this instance can no longer authenticate', () => {
        it('replaces one whose token does not validate, instead of skipping it', async () => {
            withSelection([REPO_A]);
            helper.listSubscriptions.mockResolvedValue(
                EVENT_TYPES.map((eventType) =>
                    subscriptionFor(REPO_A, eventType, {
                        consumerInputs: {
                            url: `${WEBHOOK_URL}?token=not-a-valid-token`,
                        } as any,
                    }),
                ),
            );

            await service.createWebhook(orgTeam);

            expect(helper.deleteWebhookById).toHaveBeenCalledTimes(3);
            expect(helper.createSubscriptionForProject).toHaveBeenCalledTimes(
                3,
            );
        });

        it('replaces one whose callback URL carries no token at all', async () => {
            withSelection([REPO_A]);
            helper.listSubscriptions.mockResolvedValue(
                EVENT_TYPES.map((eventType) =>
                    subscriptionFor(REPO_A, eventType, {
                        consumerInputs: { url: WEBHOOK_URL } as any,
                    }),
                ),
            );

            await service.createWebhook(orgTeam);

            expect(helper.deleteWebhookById).toHaveBeenCalledTimes(3);
            expect(helper.createSubscriptionForProject).toHaveBeenCalledTimes(
                3,
            );
        });
    });

    // ── what the delete-then-create in 1657bf18e was there to guarantee ───
    describe('exactly one subscription per repository and event', () => {
        it('does not add a second subscription when one already exists', async () => {
            withSelection([REPO_A]);
            helper.listSubscriptions.mockResolvedValue(
                allSubscriptionsFor([REPO_A]),
            );

            await service.createWebhook(orgTeam);

            expect(helper.createSubscriptionForProject).not.toHaveBeenCalled();
        });

        it('does not treat another project’s subscription for the same event as coverage', async () => {
            withSelection([REPO_A]);
            helper.listSubscriptions.mockResolvedValue(
                EVENT_TYPES.map((eventType) =>
                    subscriptionFor(REPO_A, eventType, {
                        publisherInputs: {
                            projectId: 'a-different-project',
                            repository: REPO_A.id,
                        } as any,
                    }),
                ),
            );

            await service.createWebhook(orgTeam);

            expect(helper.createSubscriptionForProject).toHaveBeenCalledTimes(
                3,
            );
        });

        it('does not treat a subscription pointing somewhere else as coverage', async () => {
            withSelection([REPO_A]);
            helper.listSubscriptions.mockResolvedValue(
                EVENT_TYPES.map((eventType) =>
                    subscriptionFor(REPO_A, eventType, {
                        consumerInputs: {
                            url: 'https://someone-else.example.com/hook',
                        } as any,
                    }),
                ),
            );

            await service.createWebhook(orgTeam);

            expect(helper.createSubscriptionForProject).toHaveBeenCalledTimes(
                3,
            );
        });
    });

    // ── chunked saves must not run overlapping passes ─────────────────────
    describe('concurrent saves (the web UI posts in chunks of 50)', () => {
        it('runs one pass and reruns it once, instead of two passes racing to create the same hooks', async () => {
            withSelection([REPO_A]);

            let releaseListing: (subs: AzureRepoSubscription[]) => void;
            helper.listSubscriptions.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        releaseListing = resolve;
                    }),
            );

            const first = service.createWebhook(orgTeam);
            // Arrives while the first pass is blocked on its listing — the
            // window in which two passes used to snapshot the same empty
            // state and both create every hook.
            const second = service.createWebhook(orgTeam);

            await second;
            expect(helper.createSubscriptionForProject).not.toHaveBeenCalled();

            // The pass resolves credentials and the persisted selection before
            // it lists, so wait until it is actually parked on the listing.
            await waitFor(() => helper.listSubscriptions.mock.calls.length === 1);

            // Let the in-flight pass finish; its rerun then sees the hooks the
            // first round created and skips them.
            releaseListing!([]);
            helper.listSubscriptions.mockResolvedValue(
                allSubscriptionsFor([REPO_A]),
            );
            await first;

            // 3 from the first round, none duplicated by the coalesced save.
            expect(helper.createSubscriptionForProject).toHaveBeenCalledTimes(
                3,
            );
            // One listing for the pass, one for its rerun.
            expect(helper.listSubscriptions).toHaveBeenCalledTimes(2);
        });
    });

    // ── the caller fires this without awaiting it ─────────────────────────
    describe('never rejects, because createOrUpdateIntegrationConfig does not await it', () => {
        it('resolves when the subscription listing fails', async () => {
            withSelection([REPO_A]);
            helper.listSubscriptions.mockRejectedValue(
                new Error('403 AccessCheckException'),
            );

            await expect(service.createWebhook(orgTeam)).resolves.toBeUndefined();
            expect(helper.createSubscriptionForProject).not.toHaveBeenCalled();
        });

        it('resolves when creating a subscription fails', async () => {
            withSelection([REPO_A]);
            helper.createSubscriptionForProject.mockRejectedValue(
                new Error('403 needs Edit Subscription on PublisherSecurity'),
            );

            await expect(service.createWebhook(orgTeam)).resolves.toBeUndefined();
        });

        it('resolves when resolving the credentials fails', async () => {
            withSelection([REPO_A]);
            jest.spyOn(service as any, 'getAuthDetails').mockRejectedValue(
                new Error('401 Unauthorized'),
            );

            await expect(service.createWebhook(orgTeam)).resolves.toBeUndefined();
        });

        it('releases the single-flight guard after a failing pass, so the next save still runs', async () => {
            withSelection([REPO_A]);
            helper.listSubscriptions.mockRejectedValueOnce(
                new Error('boom'),
            );

            await service.createWebhook(orgTeam);
            await service.createWebhook(orgTeam);

            expect(helper.listSubscriptions).toHaveBeenCalledTimes(2);
        });
    });

    // ── after a save, Azure must match the selection ─────────────────────
    describe('convergence: Azure ends up matching the selection', () => {
        it('removes the subscriptions of a repository that left the selection', async () => {
            withSelection([REPO_A]);
            helper.listSubscriptions.mockResolvedValue(
                allSubscriptionsFor([REPO_A, REPO_B]),
            );

            await service.createWebhook(orgTeam);

            const deletedIds = helper.deleteWebhookById.mock.calls.map(
                (call) => call[0].subscriptionId,
            );
            expect(deletedIds).toHaveLength(3);
            expect(
                deletedIds.every((id: string) => id.includes(REPO_B.id)),
            ).toBe(true);
        });

        it('converges without a second listing', async () => {
            withSelection([REPO_A]);
            helper.listSubscriptions.mockResolvedValue(
                allSubscriptionsFor([REPO_A, REPO_B]),
            );

            await service.createWebhook(orgTeam);

            expect(helper.listSubscriptions).toHaveBeenCalledTimes(1);
        });

        it('keeps the subscriptions of repositories that stayed', async () => {
            withSelection([REPO_A]);
            helper.listSubscriptions.mockResolvedValue(
                allSubscriptionsFor([REPO_A, REPO_B]),
            );

            await service.createWebhook(orgTeam);

            const deletedIds = helper.deleteWebhookById.mock.calls.map(
                (call) => call[0].subscriptionId,
            );
            expect(
                deletedIds.some((id: string) => id.includes(REPO_A.id)),
            ).toBe(false);
            expect(helper.createSubscriptionForProject).not.toHaveBeenCalled();
        });

        it('cleans up subscriptions left over from before an integration reset', async () => {
            // The reset deletes every integration config row, so there is no
            // previous selection to diff against — and its own webhook
            // cleanup may have failed (a 401 was observed in production).
            // Convergence against Azure is what still fixes this.
            withSelection([REPO_A]);
            helper.listSubscriptions.mockResolvedValue(
                allSubscriptionsFor([REPO_A, REPO_B]),
            );

            await service.createWebhook(orgTeam);

            expect(helper.deleteWebhookById).toHaveBeenCalledTimes(3);
        });

        it('removes everything of ours when the selection is emptied', async () => {
            withSelection([]);
            helper.listSubscriptions.mockResolvedValue(
                allSubscriptionsFor([REPO_A, REPO_B]),
            );

            await service.createWebhook(orgTeam);

            expect(helper.deleteWebhookById).toHaveBeenCalledTimes(6);
        });

        it('collapses duplicate subscriptions for the same repository and event', async () => {
            withSelection([REPO_A]);
            const subs = allSubscriptionsFor([REPO_A]);
            helper.listSubscriptions.mockResolvedValue([
                ...subs,
                // What overlapping passes used to produce: Azure then delivers
                // every event twice.
                ...subs.map((sub, i) => ({ ...sub, id: `dupe-${i}` })),
            ]);

            await service.createWebhook(orgTeam);

            const deletedIds = helper.deleteWebhookById.mock.calls.map(
                (call) => call[0].subscriptionId,
            );
            expect(deletedIds).toHaveLength(3);
            expect(
                deletedIds.every((id: string) => id.startsWith('dupe-')),
            ).toBe(true);
            expect(helper.createSubscriptionForProject).not.toHaveBeenCalled();
        });

        it('keeps the copy whose token still validates when collapsing duplicates', async () => {
            withSelection([REPO_A]);
            const good = subscriptionFor(REPO_A, 'git.pullrequest.created', {
                id: 'sub-valid-token',
            });
            const bad = subscriptionFor(REPO_A, 'git.pullrequest.created', {
                id: 'sub-broken-token',
                consumerInputs: {
                    url: `${WEBHOOK_URL}?token=not-a-valid-token`,
                } as any,
            });
            helper.listSubscriptions.mockResolvedValue([
                bad,
                good,
                ...allSubscriptionsFor([REPO_A]).filter(
                    (s) => s.eventType !== 'git.pullrequest.created',
                ),
            ]);

            await service.createWebhook(orgTeam);

            const deletedIds = helper.deleteWebhookById.mock.calls.map(
                (call) => call[0].subscriptionId,
            );
            expect(deletedIds).toEqual(['sub-broken-token']);
        });

        it('never touches a subscription delivering to another Kodus instance', async () => {
            withSelection([REPO_A]);
            helper.listSubscriptions.mockResolvedValue([
                ...allSubscriptionsFor([REPO_A]),
                subscriptionFor(REPO_B, 'git.pullrequest.created', {
                    id: 'sub-other-instance',
                    consumerInputs: {
                        url: 'https://other-kodus.example.com/azure-repos/webhook?token=x',
                    } as any,
                }),
            ]);

            await service.createWebhook(orgTeam);

            expect(helper.deleteWebhookById).not.toHaveBeenCalled();
        });

        it('never touches a webhook that is not ours at all', async () => {
            withSelection([REPO_A]);
            helper.listSubscriptions.mockResolvedValue([
                ...allSubscriptionsFor([REPO_A]),
                subscriptionFor(REPO_B, 'git.push', {
                    id: 'sub-someone-else',
                    consumerInputs: {
                        url: 'https://jenkins.example.com/hook',
                    } as any,
                }),
            ]);

            await service.createWebhook(orgTeam);

            expect(helper.deleteWebhookById).not.toHaveBeenCalled();
        });

        it('deletes nothing when the desired state is unknown (no config row)', async () => {
            // The dangerous case: a nullish read is not "the user deselected
            // everything", and treating it as such would wipe every hook.
            jest.spyOn(
                service as any,
                'findOneByOrganizationAndTeamDataAndConfigKey',
            ).mockResolvedValue(null);
            helper.listSubscriptions.mockResolvedValue(
                allSubscriptionsFor([REPO_A]),
            );

            await service.createWebhook(orgTeam);

            expect(helper.listSubscriptions).not.toHaveBeenCalled();
            expect(helper.deleteWebhookById).not.toHaveBeenCalled();
        });

        it('deletes nothing when reading the selection fails', async () => {
            jest.spyOn(
                service as any,
                'findOneByOrganizationAndTeamDataAndConfigKey',
            ).mockRejectedValue(new Error('database unavailable'));
            helper.listSubscriptions.mockResolvedValue(
                allSubscriptionsFor([REPO_A]),
            );

            await expect(
                service.createWebhook(orgTeam),
            ).resolves.toBeUndefined();
            expect(helper.deleteWebhookById).not.toHaveBeenCalled();
        });

        it('keeps pruning after one removal fails', async () => {
            withSelection([]);
            helper.listSubscriptions.mockResolvedValue(
                allSubscriptionsFor([REPO_A]),
            );
            helper.deleteWebhookById
                .mockRejectedValueOnce(new Error('403'))
                .mockResolvedValue(undefined);

            await service.createWebhook(orgTeam);

            expect(helper.deleteWebhookById).toHaveBeenCalledTimes(3);
        });
    });

    // ── the reported scenario, end to end ────────────────────────────────
    describe('ownership: one team never deletes another team\'s hooks', () => {
        /**
         * The callback URL is a single deployment-wide env var and nothing
         * stops two Kodus teams from connecting the same Azure organization,
         * so "points at our webhook URL" is not proof of ownership. Only the
         * team marker is.
         */
        it('marks the subscriptions it creates with the saving team', async () => {
            withSelection([REPO_A]);

            await service.createWebhook(orgTeam);

            const urls = helper.createSubscriptionForProject.mock.calls.map(
                (call) => call[0].subscriptionPayload.consumerInputs.url,
            );

            expect(urls).toHaveLength(3);
            urls.forEach((url: string) => {
                expect(new URL(url).searchParams.get('team')).toBe(
                    orgTeam.teamId,
                );
            });
        });

        it('leaves another team\'s subscription alone even when the repository is not in this selection', async () => {
            withSelection([REPO_A]);
            helper.listSubscriptions.mockResolvedValue([
                ...allSubscriptionsFor([REPO_A]),
                ...EVENT_TYPES.map((eventType) =>
                    subscriptionFor(REPO_B, eventType, {}, 'team-somebody-else'),
                ),
            ]);

            await service.createWebhook(orgTeam);

            expect(helper.deleteWebhookById).not.toHaveBeenCalled();
        });

        it('leaves an unmarked subscription alone when its repository is not in the selection', async () => {
            withSelection([REPO_A]);
            helper.listSubscriptions.mockResolvedValue([
                ...allSubscriptionsFor([REPO_A]),
                // No team marker: minted before ownership was recorded, so it
                // belongs to nobody and is not ours to remove.
                ...EVENT_TYPES.map((eventType) =>
                    subscriptionFor(REPO_B, eventType, {}, NO_TEAM),
                ),
            ]);

            await service.createWebhook(orgTeam);

            expect(helper.deleteWebhookById).not.toHaveBeenCalled();
        });

        it('replaces an unmarked subscription of a selected repository instead of creating a second one', async () => {
            withSelection([REPO_A]);
            helper.listSubscriptions.mockResolvedValue(
                EVENT_TYPES.map((eventType) =>
                    subscriptionFor(REPO_A, eventType, {}, NO_TEAM),
                ),
            );

            await service.createWebhook(orgTeam);

            // Replaced, not duplicated: Azure would otherwise deliver every
            // event twice for this repository.
            expect(helper.deleteWebhookById).toHaveBeenCalledTimes(3);
            expect(helper.createSubscriptionForProject).toHaveBeenCalledTimes(3);

            const urls = helper.createSubscriptionForProject.mock.calls.map(
                (call) => call[0].subscriptionPayload.consumerInputs.url,
            );
            urls.forEach((url: string) => {
                expect(new URL(url).searchParams.get('team')).toBe(
                    orgTeam.teamId,
                );
            });
        });

        it('does not rewrite a subscription this team already marked', async () => {
            withSelection([REPO_A]);
            helper.listSubscriptions.mockResolvedValue(
                allSubscriptionsFor([REPO_A]),
            );

            await service.createWebhook(orgTeam);

            expect(helper.createSubscriptionForProject).not.toHaveBeenCalled();
            expect(helper.deleteWebhookById).not.toHaveBeenCalled();
        });
    });

    describe('health: a subscription Azure stopped delivering is not coverage', () => {
        /**
         * Azure moves a subscription out of `enabled` by itself after repeated
         * delivery failures or when the creating identity goes inactive. The
         * old code deleted and recreated on every save and healed these as a
         * side effect; skipping redundant work means the check is explicit.
         */
        it.each([
            'onProbation',
            'disabledBySystem',
            'disabledByUser',
            'disabledByInactiveIdentity',
        ])('replaces a subscription in %s', async (status) => {
            withSelection([REPO_A]);
            helper.listSubscriptions.mockResolvedValue(
                EVENT_TYPES.map((eventType) =>
                    subscriptionFor(REPO_A, eventType, { status } as any),
                ),
            );

            await service.createWebhook(orgTeam);

            expect(helper.deleteWebhookById).toHaveBeenCalledTimes(3);
            expect(helper.createSubscriptionForProject).toHaveBeenCalledTimes(3);
        });

        it('leaves an enabled subscription alone', async () => {
            withSelection([REPO_A]);
            helper.listSubscriptions.mockResolvedValue(
                EVENT_TYPES.map((eventType) =>
                    subscriptionFor(REPO_A, eventType, {
                        status: 'enabled',
                    } as any),
                ),
            );

            await service.createWebhook(orgTeam);

            expect(helper.createSubscriptionForProject).not.toHaveBeenCalled();
            expect(helper.deleteWebhookById).not.toHaveBeenCalled();
        });

        it('treats a missing status as enabled rather than churning', async () => {
            withSelection([REPO_A]);
            helper.listSubscriptions.mockResolvedValue(
                allSubscriptionsFor([REPO_A]),
            );

            await service.createWebhook(orgTeam);

            expect(helper.createSubscriptionForProject).not.toHaveBeenCalled();
        });

        it('keeps the delivering copy when collapsing duplicates, not just the one with a valid token', async () => {
            const eventType = EVENT_TYPES[0];

            withSelection([REPO_A]);
            helper.listSubscriptions.mockResolvedValue([
                // Valid token, but Azure stopped delivering it.
                subscriptionFor(REPO_A, eventType, {
                    id: 'sub-dead',
                    status: 'disabledBySystem',
                } as any),
                // Delivering, and its token still validates.
                subscriptionFor(REPO_A, eventType, {
                    id: 'sub-alive',
                    status: 'enabled',
                } as any),
            ]);

            await service.createWebhook(orgTeam);

            const deletedIds = helper.deleteWebhookById.mock.calls.map(
                (call) => call[0].subscriptionId,
            );
            expect(deletedIds).toContain('sub-dead');
            expect(deletedIds).not.toContain('sub-alive');
        });
    });

    describe('the one listing the whole pass depends on', () => {
        it('writes nothing anywhere when the listing fails', async () => {
            withSelection([REPO_A, REPO_B]);
            helper.listSubscriptions.mockRejectedValue(
                new Error('429 Too Many Requests'),
            );

            await service.createWebhook(orgTeam);

            expect(helper.createSubscriptionForProject).not.toHaveBeenCalled();
            expect(helper.deleteWebhookById).not.toHaveBeenCalled();
        });

        it('does not reject, so the fire-and-forget caller cannot crash the process', async () => {
            withSelection([REPO_A]);
            helper.listSubscriptions.mockRejectedValue(
                new Error('403 Forbidden'),
            );

            await expect(service.createWebhook(orgTeam)).resolves.toBeUndefined();
        });

        it('releases the single-flight guard, so the next save still runs', async () => {
            withSelection([REPO_A]);
            helper.listSubscriptions.mockRejectedValueOnce(
                new Error('500 Internal Server Error'),
            );

            await service.createWebhook(orgTeam);

            helper.listSubscriptions.mockResolvedValue([]);
            await service.createWebhook(orgTeam);

            expect(helper.createSubscriptionForProject).toHaveBeenCalledTimes(3);
        });
    });

    describe('the scenario this was reported from', () => {
        /**
         * "I connected Azure, saved the repos, it created the webhooks. Then I
         * cleared the integration to change the key, connected again, and when
         * saving I removed some repos — it has to end up up to date."
         *
         * The reset deletes every integration config row, so there is no
         * previous selection to diff against, and its own webhook cleanup can
         * fail (a 401 was observed). Azure therefore still holds the full set
         * from before, and the save that follows is the only thing that can
         * fix it.
         */
        const REPO_C: Repo = {
            id: 'repo-c',
            name: 'mobile-app',
            project: { id: 'project-1' },
        };

        it('leaves Azure matching the new selection exactly', async () => {
            // Before the reset the team had three repositories subscribed.
            const beforeReset = allSubscriptionsFor([REPO_A, REPO_B, REPO_C]);

            // After reconnecting, the user saves only two of them.
            withSelection([REPO_A, REPO_B]);
            helper.listSubscriptions.mockResolvedValue(beforeReset);

            await service.createWebhook(orgTeam);

            // REPO_C's three subscriptions are gone.
            const deletedIds = helper.deleteWebhookById.mock.calls.map(
                (call) => call[0].subscriptionId,
            );
            expect(deletedIds).toHaveLength(3);
            expect(
                deletedIds.every((id: string) => id.includes(REPO_C.id)),
            ).toBe(true);

            // The two that stayed were left alone, not recreated.
            expect(helper.createSubscriptionForProject).not.toHaveBeenCalled();

            // And it cost one Azure listing.
            expect(helper.listSubscriptions).toHaveBeenCalledTimes(1);
        });

        it('creates what is missing and removes what is stale in the same save', async () => {
            // Azure still holds REPO_C from before the reset; the new
            // selection swaps it for REPO_B, which has no hooks yet.
            withSelection([REPO_A, REPO_B]);
            helper.listSubscriptions.mockResolvedValue(
                allSubscriptionsFor([REPO_A, REPO_C]),
            );

            await service.createWebhook(orgTeam);

            const createdRepos = new Set(
                helper.createSubscriptionForProject.mock.calls.map(
                    (call) =>
                        call[0].subscriptionPayload.publisherInputs.repository,
                ),
            );
            expect([...createdRepos]).toEqual([REPO_B.id]);

            const deletedIds = helper.deleteWebhookById.mock.calls.map(
                (call) => call[0].subscriptionId,
            );
            expect(
                deletedIds.every((id: string) => id.includes(REPO_C.id)),
            ).toBe(true);
            expect(deletedIds).toHaveLength(3);
        });

        it('is idempotent: saving the same selection again changes nothing', async () => {
            withSelection([REPO_A, REPO_B]);
            helper.listSubscriptions.mockResolvedValue(
                allSubscriptionsFor([REPO_A, REPO_B]),
            );

            await service.createWebhook(orgTeam);

            expect(helper.createSubscriptionForProject).not.toHaveBeenCalled();
            expect(helper.deleteWebhookById).not.toHaveBeenCalled();
            expect(helper.listSubscriptions).toHaveBeenCalledTimes(1);
        });
    });

    // ── the integration-reset path has the same listing shape ─────────────
    describe('deleteWebhook (integration reset)', () => {
        beforeEach(() => {
            jest.spyOn(
                service as any,
                'getProjectIdFromRepository',
            ).mockImplementation(async (_org: any, repoId: any) =>
                repoId === REPO_A.id ? REPO_A.project.id : REPO_B.project.id,
            );
        });

        it('lists the organization subscriptions once for the whole pass', async () => {
            withSelection([REPO_A, REPO_B]);
            helper.listSubscriptions.mockResolvedValue(
                allSubscriptionsFor([REPO_A, REPO_B]),
            );

            await service.deleteWebhook({ organizationAndTeamData: orgTeam });

            // One per repository before the fix.
            expect(helper.listSubscriptions).toHaveBeenCalledTimes(1);
        });

        it('deletes every Kodus subscription of every selected repository', async () => {
            withSelection([REPO_A, REPO_B]);
            helper.listSubscriptions.mockResolvedValue(
                allSubscriptionsFor([REPO_A, REPO_B]),
            );

            await service.deleteWebhook({ organizationAndTeamData: orgTeam });

            expect(helper.deleteWebhookById).toHaveBeenCalledTimes(6);
        });

        it('leaves subscriptions that are not ours alone', async () => {
            withSelection([REPO_A]);
            helper.listSubscriptions.mockResolvedValue([
                ...allSubscriptionsFor([REPO_A]),
                subscriptionFor(REPO_A, 'git.push', {
                    id: 'sub-someone-else',
                    consumerInputs: {
                        url: 'https://someone-else.example.com/hook',
                    } as any,
                }),
            ]);

            await service.deleteWebhook({ organizationAndTeamData: orgTeam });

            const deletedIds = helper.deleteWebhookById.mock.calls.map(
                (call) => call[0].subscriptionId,
            );
            expect(deletedIds).not.toContain('sub-someone-else');
            expect(deletedIds).toHaveLength(3);
        });

        it('does not touch another project’s subscription for the same repository id', async () => {
            withSelection([REPO_A]);
            helper.listSubscriptions.mockResolvedValue([
                subscriptionFor(REPO_A, 'git.pullrequest.created', {
                    id: 'sub-other-project',
                    publisherInputs: {
                        projectId: 'a-different-project',
                        repository: REPO_A.id,
                    } as any,
                }),
            ]);

            await service.deleteWebhook({ organizationAndTeamData: orgTeam });

            expect(helper.deleteWebhookById).not.toHaveBeenCalled();
        });

        it('resolves without deleting anything when the listing fails', async () => {
            withSelection([REPO_A]);
            helper.listSubscriptions.mockRejectedValue(
                new Error('401 Unauthorized - PAT expired'),
            );

            await expect(
                service.deleteWebhook({ organizationAndTeamData: orgTeam }),
            ).resolves.toBeUndefined();
            expect(helper.deleteWebhookById).not.toHaveBeenCalled();
        });

        it('does nothing on Azure when the connection is not PAT-based', async () => {
            withSelection([REPO_A]);
            jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
                orgName: 'my-org',
                token: 'x',
                authMode: 'oauth',
            });

            await service.deleteWebhook({ organizationAndTeamData: orgTeam });

            expect(helper.listSubscriptions).not.toHaveBeenCalled();
            expect(helper.deleteWebhookById).not.toHaveBeenCalled();
        });
    });
});
