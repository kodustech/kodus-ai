import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { RuntimeForkApprovedSchema } from '@libs/runtime/contracts/runtime-commands';

import { RuntimeEnvironmentMembers } from '../application/environment-members.service';
import { RuntimeRunAccessService } from '../application/run-access.service';
import { RuntimeRunRequestBuilder } from '../application/run-request-builder.service';
import { RuntimeRunEnqueuer } from '../application/runtime-run-enqueuer.service';
import { ApproveForkRunUseCase } from '../application/use-cases/approve-fork-run.use-case';
import { BASE_SHA, clock, config, FakeOutbox, InMemoryEnvironmentRepositories, openSealed, ORG, realAuthorization, REPO, run, SECRET, SHA, storeWith, TEAM, user } from './fixtures';
import { InMemoryRunTargetStore } from '@libs/runtime-publish/testing';

// A fork approval of a multi-repository Run carries fresh tokens for every
// other repository too: the ones its request carried expired while it waited.

const C = 'c'.repeat(40);
const ENV = { environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop', state: 'active' as const };

const git = {
    getPullRequestHead: async () => ({ headSha: SHA, baseSha: BASE_SHA, fork: true, authorId: '42', authorLogin: 'forker', state: 'open' }),
    resolveGitIdentity: async () => ({ id: '7', login: 'maintainer' }),
    userCanWrite: async () => true,
} as any;

async function setup(workspace?: Parameters<InMemoryRunTargetStore['record']>[0]['workspace']) {
    const r = run({ state: 'awaiting_approval' });
    const rows = new InMemoryEnvironmentRepositories([{ environmentId: 'env-1', organizationId: ORG }]);
    const at = '2026-10-29T10:00:00.000Z';
    rows.rows.push(
        { environmentId: 'env-1', organizationId: ORG, repositoryId: REPO, repositoryName: 'acme/shop', fullName: 'acme/shop', role: 'primary', alias: 'shop', triggers: true, pairBranches: false, createdAt: at, updatedAt: at },
        { environmentId: 'env-1', organizationId: ORG, repositoryId: 'repo-billing', repositoryName: 'billing', fullName: 'acme/billing', role: 'member', alias: 'billing', triggers: true, pairBranches: false, createdAt: at, updatedAt: at },
    );
    const environments = { findByRepository: async () => null, get: async () => ENV } as any;
    const issued: Array<{ repositoryId: string }> = [];
    const builder = new RuntimeRunRequestBuilder(
        git,
        { issue: async (i: any) => (issued.push(i), `token-${i.repositoryId}-${issued.length}`) },
        { get: async () => null },
        config({ runTokenSecret: SECRET }),
        clock,
        new RuntimeEnvironmentMembers(environments, rows),
    );
    const targets = new InMemoryRunTargetStore();
    await targets.record({ runId: r.runId, attempt: 1, organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop', platform: PlatformType.GITHUB, pullRequestNumber: r.prNumber, headSha: SHA, ...(workspace ? { workspace } : {}) });
    const outbox = new FakeOutbox();
    const enqueuer = new RuntimeRunEnqueuer(targets, outbox as any, { getTypeIntegration: async () => PlatformType.GITHUB });
    const uc = new ApproveForkRunUseCase(new RuntimeRunAccessService(await storeWith(r), realAuthorization()), git, outbox as any, clock, builder, enqueuer, environments);
    return { r, uc, outbox, issued };
}

const sentOf = (outbox: FakeOutbox) => {
    const { workflowType: _t, ...body } = (outbox as any).rows[0].payload.payload;
    return RuntimeForkApprovedSchema.parse(body);
};

describe('a fork approval of a multi-repository Run', () => {
    it('mints one token per side for every other repository, sealed for the Run', async () => {
        const s = await setup([
            { repositoryId: REPO, alias: 'shop', baseSha: BASE_SHA, headSha: SHA, source: 'pull_request' },
            { repositoryId: 'repo-billing', alias: 'billing', baseSha: C, headSha: C, source: 'default_branch', branch: 'main' },
        ]);
        await s.uc.execute({ user: user(Role.REPO_ADMIN), runId: s.r.runId });
        const sent = sentOf(s.outbox);
        expect(sent.tokens!.workspace).toHaveLength(1);
        const member = sent.tokens!.workspace![0];
        expect(member.repositoryId).toBe('repo-billing');
        expect(openSealed(member.sealedRepoToken, s.r.runId)).toMatch(/^token-repo-billing-/);
        expect(openSealed(member.sealedPrRepoToken!, s.r.runId)).toMatch(/^token-repo-billing-/);
        expect(s.issued.filter((i) => i.repositoryId === 'repo-billing')).toHaveLength(2);
    });

    it('a Run of one repository is approved as before, with no member tokens', async () => {
        const s = await setup();
        await s.uc.execute({ user: user(Role.REPO_ADMIN), runId: s.r.runId });
        expect(sentOf(s.outbox).tokens).not.toHaveProperty('workspace');
        expect(s.issued.every((i) => i.repositoryId === REPO)).toBe(true);
    });
});
