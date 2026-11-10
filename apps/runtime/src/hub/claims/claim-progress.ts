import type { MessageBody } from '@libs/runtime/protocol';

// Where each claim's preparation is (claim.progress from its cell), for the
// worker to show on the setup while it waits for claim.ready. Best effort and
// held by the replica the cell talks to; bounded, and forgotten after a while.

export type ClaimProgressPhase = { phase: string; state: 'started' | 'done'; at: string; ms?: number };
export type ClaimProgressView = { phases: ClaimProgressPhase[]; lines: string[]; updatedAt: string };

const MAX_CLAIMS = 1_000;
const MAX_PHASES = 32;
const TTL_MS = 2 * 60 * 60 * 1000;

type Entry = ClaimProgressView & { orgId: string; touched: number };

export class ClaimProgressBook {
    private readonly byClaim = new Map<string, Entry>();

    record(claimId: string, orgId: string, body: MessageBody<'claim.progress'>, now: Date) {
        const t = now.getTime();
        for (const [id, e] of this.byClaim) if (t - e.touched > TTL_MS) this.byClaim.delete(id);
        let e = this.byClaim.get(claimId);
        if (!e || e.orgId !== orgId) {
            if (this.byClaim.size >= MAX_CLAIMS) this.byClaim.delete(this.byClaim.keys().next().value!);
            e = { orgId, phases: [], lines: [], updatedAt: body.at, touched: t };
            this.byClaim.set(claimId, e);
        }
        const phase: ClaimProgressPhase = { phase: body.phase, state: body.state, at: body.at, ...(body.ms !== undefined ? { ms: body.ms } : {}) };
        // One row per phase: "done" replaces its "started", a later "started" (a fresh tail of lines) keeps it.
        const i = e.phases.findIndex((p) => p.phase === body.phase);
        if (i < 0) e.phases.push(phase);
        else if (body.state === 'done' || e.phases[i].state === 'started') e.phases[i] = { ...phase, at: body.state === 'done' ? body.at : e.phases[i].at };
        if (e.phases.length > MAX_PHASES) e.phases.splice(0, e.phases.length - MAX_PHASES);
        if (body.lines) e.lines = body.lines;
        e.updatedAt = body.at;
        e.touched = t;
    }

    /** The claim's progress for its own org only; null otherwise. */
    get(claimId: string, orgId: string): ClaimProgressView | null {
        const e = this.byClaim.get(claimId);
        if (!e || e.orgId !== orgId) return null;
        return { phases: e.phases.map((p) => ({ ...p })), lines: [...e.lines], updatedAt: e.updatedAt };
    }
}
