// Test doubles of the publish ports (libs/runtime/AGENTS.md): specs and test fixtures import them, production code never does.
import {
    COMMENT_SLOT_LEASE_MS,
    type CommentSlotPatch,
    definedOnly,
    type PullRequestCommentSlot,
    type PullRequestCommentSlotStore,
    type PullRequestRef,
} from './domain/pull-request-comment-slot';
import { type RunTarget, RunTargetConflictError, type RunTargetScope, type RunTargetStore, sameRunTarget } from './domain/run-target';
import {
    canClaim,
    type ClaimRequest,
    type ClaimResult,
    hasVerdict,
    isStaleForRedrive,
    PUBLICATION_LEASE_MS,
    type PublicationReader,
    type PublicationRedriveStore,
    type PublicationResult,
    type PublicationRetryState,
    type PublicationStore,
    refusalState,
    type RuntimePublication,
} from './domain/runtime-publication';

const copyOf = (t: RunTarget): RunTarget => ({ ...t, ...(t.workspace ? { workspace: t.workspace.map((r) => ({ ...r })) } : {}) });

const slotKey = (pr: PullRequestRef) =>
    `${pr.organizationId}/${pr.repositoryId}/${pr.prNumber}/${pr.environmentKey ?? ''}`;

export class InMemoryRunTargetStore implements RunTargetStore {
    readonly rows = new Map<string, RunTarget>();

    async record(target: RunTarget): Promise<void> {
        const existing = this.rows.get(target.runId);
        if (existing && !sameRunTarget(existing, target)) {
            throw new RunTargetConflictError(target.runId);
        }
        this.rows.set(target.runId, copyOf(target));
    }

    async get(runId: string, scope?: RunTargetScope): Promise<RunTarget | null> {
        const row = this.rows.get(runId);
        if (!row || (scope && row.organizationId !== scope.organizationId)) return null;
        return copyOf(row);
    }
}

export class InMemoryPublicationStore
    implements PublicationStore, PublicationReader, PublicationRedriveStore
{
    readonly rows = new Map<string, RuntimePublication>();

    async claim(request: ClaimRequest, now = new Date()): Promise<ClaimResult> {
        const existing = this.rows.get(request.key);
        const leaseUntil = new Date(
            now.getTime() + PUBLICATION_LEASE_MS,
        ).toISOString();
        if (!existing) {
            const publication: RuntimePublication = {
                ...request,
                checkRank: undefined,
                status: 'publishing',
                leaseUntil,
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            };
            this.rows.set(request.key, publication);
            return { state: 'claimed', publication: { ...publication } };
        }
        if (!canClaim(existing, request, now)) {
            return {
                state: refusalState(existing, now),
                publication: { ...existing },
            };
        }
        const publication: RuntimePublication = {
            ...existing,
            ...(request.request ? { request: request.request } : {}),
            status: 'publishing',
            leaseUntil,
            updatedAt: now.toISOString(),
        };
        this.rows.set(request.key, publication);
        return { state: 'claimed', publication: { ...publication } };
    }

    async complete(key: string, result: PublicationResult) {
        const row = this.rows.get(key);
        if (!row) return;
        this.rows.set(key, {
            ...row,
            ...result,
            leaseUntil: undefined,
            updatedAt: new Date().toISOString(),
        });
    }

    async release(key: string, reason: string, keep?: PublicationRetryState) {
        const row = this.rows.get(key);
        if (!row) return;
        this.rows.set(key, {
            ...row,
            ...keep,
            status: 'failed',
            reason,
            leaseUntil: undefined,
            updatedAt: new Date().toISOString(),
        });
    }

    async findCheckRunId(key: string) {
        return this.rows.get(key)?.checkRunId ?? null;
    }

    async hasPublishedVerdict(key: string) {
        return hasVerdict(this.rows.get(key));
    }

    async listForRun(organizationId: string, runId: string) {
        return [...this.rows.values()]
            .filter((r) => r.organizationId === organizationId && r.runId === runId)
            .map(({ request: _request, ...row }) => ({ ...row }));
    }

    async findStale(staleBefore: string, now: string, limit: number) {
        return [...this.rows.values()]
            .filter((r) => isStaleForRedrive(r, staleBefore, now))
            .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
            .slice(0, limit)
            .map((r) => ({ ...r }));
    }

    async reserveRedrive(key: string, seenUpdatedAt: string, now: string) {
        const row = this.rows.get(key);
        if (!row || row.updatedAt !== seenUpdatedAt || row.redrive?.gaveUpAt) {
            return null;
        }
        if (row.status !== 'failed' && row.status !== 'publishing') return null;
        const next: RuntimePublication = {
            ...row,
            redrive: { ...row.redrive, attempts: (row.redrive?.attempts ?? 0) + 1, lastAt: now },
            updatedAt: now,
        };
        this.rows.set(key, next);
        return { ...next };
    }

    async giveUp(key: string, reason: string, now: string) {
        const row = this.rows.get(key);
        if (!row) return;
        this.rows.set(key, {
            ...row,
            status: 'failed',
            leaseUntil: undefined,
            redrive: { attempts: row.redrive?.attempts ?? 0, ...row.redrive, gaveUpAt: now, gaveUpReason: reason },
            updatedAt: now,
        });
    }
}

export class InMemoryCommentSlotStore implements PullRequestCommentSlotStore {
    readonly rows = new Map<string, PullRequestCommentSlot>();

    async acquire(pr: PullRequestRef, owner: string, now = new Date()) {
        const key = slotKey(pr);
        const existing = this.rows.get(key);
        if (
            existing?.leaseUntil &&
            Date.parse(existing.leaseUntil) > now.getTime()
        ) {
            return null;
        }
        const slot: PullRequestCommentSlot = {
            ...(existing ?? pr),
            leaseOwner: owner,
            leaseUntil: new Date(
                now.getTime() + COMMENT_SLOT_LEASE_MS,
            ).toISOString(),
            updatedAt: now.toISOString(),
        };
        this.rows.set(key, slot);
        return { ...slot };
    }

    async update(pr: PullRequestRef, owner: string, patch: CommentSlotPatch) {
        const key = slotKey(pr);
        const row = this.rows.get(key);
        if (!row || row.leaseOwner !== owner) return;
        const next: PullRequestCommentSlot = {
            ...row,
            ...definedOnly(patch),
            updatedAt: new Date().toISOString(),
        };
        if (patch.createPending === false) delete next.createPending;
        this.rows.set(key, next);
    }

    async release(pr: PullRequestRef, owner: string) {
        const key = slotKey(pr);
        const row = this.rows.get(key);
        if (!row || row.leaseOwner !== owner) return;
        const { leaseOwner: _o, leaseUntil: _u, ...rest } = row;
        this.rows.set(key, rest);
    }
}
