import { sealSecret } from '@libs/runtime/run/sealed-secret';

import { shopRunRequest } from '../../e2e/fixtures';
import type { AdmissionLimits, AdmissionPayload } from './admission-contract';
import { InMemoryAdmissionStore } from './testing';

// A fork approval of a multi-repository Run stores the members' fresh tokens
// in the Run's workspace, never as a field over it: a recovered Run boots
// as the approved one does.

const AT = Date.parse('2026-11-11T12:00:00Z');
const limits: AdmissionLimits = { globalWaiting: 20, perOrgWaiting: 10, globalExecuting: 3, perOrgExecuting: 2, maxAttempts: 3 };
const C = 'c'.repeat(40);

describe('a fork approval in the admission store', () => {
    it("keeps the workspace and puts each member's fresh tokens in it", async () => {
        const store = new InMemoryAdmissionStore({ now: () => new Date(AT), hasLiveClaims: async () => false });
        const base = shopRunRequest();
        const key = Buffer.alloc(32, 1);
        const seal = (v: string) => sealSecret(v, key, base.runId);
        const request = {
            ...base,
            requestedAt: new Date(AT).toISOString(),
            pullRequest: { ...base.pullRequest, fork: true },
            workspace: [
                { repositoryId: base.repository.id, fullName: 'demo/shop', alias: 'shop', role: 'primary' as const, baseSha: base.pullRequest.baseSha, headSha: base.pullRequest.headSha, source: 'pull_request' as const },
                { repositoryId: 'repo-billing', fullName: 'demo/billing', alias: 'billing', role: 'member' as const, baseSha: C, headSha: C, source: 'default_branch' as const, sealedRepoToken: seal('old') },
            ],
        };
        const input: AdmissionPayload = { kind: 'run', request };
        const accepted = await store.accept(input, limits);
        if (!('record' in accepted)) throw new Error(accepted.status);
        const tokens = { repoToken: seal('own-new'), runToken: seal('run-new'), workspace: [{ repositoryId: 'repo-billing', sealedRepoToken: seal('bill-new'), sealedPrRepoToken: seal('bill-pr-new') }] };
        const approved = await store.approveRun({ organizationId: request.organizationId, kind: 'run', key: request.runId }, tokens, limits);
        const stored = approved.record!.payload!;
        if (stored.kind !== 'run') throw new Error('not a run');
        expect(stored.request.repoToken).toBe(tokens.repoToken);
        expect(stored.request.workspace).toHaveLength(2);
        expect(stored.request.workspace![1]).toMatchObject({ alias: 'billing', sealedRepoToken: tokens.workspace[0].sealedRepoToken, sealedPrRepoToken: tokens.workspace[0].sealedPrRepoToken });
        expect(stored.request.workspace![0]).toEqual(request.workspace[0]);
    });
});
