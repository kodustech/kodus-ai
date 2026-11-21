import { randomUUID } from 'crypto';

import { previewIdFor, PREVIEW_REASONS } from '@libs/runtime/contracts/preview';
import type { EnvironmentRuntime } from '@libs/runtime/environment';
import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';

import { shopRunRequest } from '../../e2e/fixtures';
import { type PreviewRow } from '../../shared/persistence/preview-store';
import { PreviewService } from '../preview/preview.service';
import { RunCancelRequestedHandler, RunRequestedHandler } from './run-requested.handler';
import { InMemoryPrAdmissionStore } from '../../shared/admission/testing';
import { InMemoryDistributedLocks, InMemoryPreviewStore } from '../../shared/persistence/testing';

// The pull request flow the Runtime already has ends previews (docs/runtime/preview-urls.md §5.2):
// a newer Run of the PR replaces the older Runs' previews, and the PR closing ends every one.

const ORG = 'org-demo';

function previewOf(runId: string, prNumber: number): PreviewRow {
    const previewId = previewIdFor(ORG, runId, 'pr');
    const at = new Date().toISOString();
    return {
        previewId,
        organizationId: ORG,
        environmentId: 'shop',
        repositoryId: 'repo-shop',
        repositoryFullName: 'demo/shop',
        runId,
        prNumber,
        side: 'pr',
        sha: 'b'.repeat(40),
        host: `p-${previewId.slice(4)}-pr.preview.example`,
        state: 'sleeping',
        openedBy: 'user-1',
        withoutSecrets: true,
        forkPullRequest: false,
        starts: 1,
        createdAt: at,
        updatedAt: at,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
}

function harness() {
    const store = new InMemoryPreviewStore();
    const previews = new PreviewService({
        store,
        setups: { get: async () => null },
        environment: () => ({ release: async () => undefined }) as unknown as EnvironmentRuntime,
        hub: { route: async () => true, unroute: async () => undefined },
        isStopped: async () => false,
        domain: 'preview.example',
    });
    const projection = new InMemoryRunProjectionStore();
    const engine = { start: jest.fn(), stop: jest.fn() };
    const locks = new InMemoryDistributedLocks();
    const admissions = new InMemoryPrAdmissionStore();
    const requested = new RunRequestedHandler(engine as any, projection, { isStopped: async () => false } as any, locks, admissions, undefined, { previews });
    const cancel = new RunCancelRequestedHandler(engine as any, projection, locks, admissions, previews);
    return { store, requested, cancel };
}

describe('previews end with the pull request flow', () => {
    it("a newer Run of the pull request ends the older Runs' previews, not its own nor another PR's", async () => {
        const h = harness();
        const older = previewOf('run-old', 42);
        const otherPr = previewOf('run-other', 43);
        await h.store.insertPreview(older);
        await h.store.insertPreview(otherPr);
        const next = shopRunRequest({ runId: 'run-new' });
        await h.store.insertPreview(previewOf('run-new', 42));
        await h.requested.requested(next);
        expect(h.store.previews.get(older.previewId)).toMatchObject({ state: 'expired', reason: PREVIEW_REASONS.newerRun });
        expect(h.store.previews.get(previewIdFor(ORG, 'run-new', 'pr'))!.state).toBe('sleeping');
        expect(h.store.previews.get(otherPr.previewId)!.state).toBe('sleeping');
    });

    it('the pull request closing ends its previews; a push that supersedes a Run does not by itself', async () => {
        const h = harness();
        const open = previewOf('run-1', 42);
        await h.store.insertPreview(open);
        const cancel = (reason: 'superseded' | 'pr_closed') =>
            h.cancel.handle({ organizationId: ORG, repositoryId: 'repo-shop', prNumber: 42, reason, ...(reason === 'superseded' ? { headSha: 'c'.repeat(40) } : {}) }, { messageId: randomUUID() } as any);
        await cancel('superseded');
        expect(h.store.previews.get(open.previewId)!.state).toBe('sleeping');
        await cancel('pr_closed');
        expect(h.store.previews.get(open.previewId)).toMatchObject({ state: 'expired', reason: PREVIEW_REASONS.prClosed });
    });
});
