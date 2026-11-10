import type { Consumer } from '@libs/runtime/environment';
import type { HeartbeatMemory } from '@libs/runtime/protocol';
import type {
    PhysicalAdmissionTicket,
    PhysicalAdmissionResult,
} from '../../shared/admission-contract';
import { claimIdFor } from '../../shared/claim-id';

// Memory admission on the hub (ADR-070). A cell whose claims share its host
// memory (docker-gvisor) reports in each heartbeat what it may commit to
// claims and what it has committed (heartbeat memory, feature cellMemory).
// The replica that holds the cell admits a claim there only when what the
// claim will be counted for fits: what the cell committed, plus the claims
// this replica admitted that the cell had not listed yet, plus what is set
// aside for the other side of a Run already admitted here. A claim that
// does not fit is refused before anything is recorded or sent (the worker
// waits and asks again), and claims that asked this cell first go first.
//
// Only this replica sends claims to the cell (it holds the session), and
// each admission runs without an await, so two admissions never read the
// same free memory. The cell checks again with its own ledger (exact): the
// hub's view is what keeps a claim from reaching a full cell and keeps the
// order. A cell that sends no memory is admitted by free slots, as before.

/** A claim the hub admitted and the cell has not listed yet stops counting here after this: the cell refused or lost it. */
export const UNLISTED_TTL_MS = 2 * 60_000;
/** What is set aside for a Run's other side, until that side asks. */
export const SIBLING_TTL_MS = 2 * 60_000;
/** A claim that waited and did not ask again for this long left the line (its Run ended, or it went to another cell). */
export const WAITER_TTL_MS = 60_000;

export interface MemoryClaim {
    claimId: string;
    runId?: string | null;
    side: string;
    consumer: Consumer;
    /** The machine size the claim asks (MB); absent: the cell's default. */
    sizeMb?: number;
    /**
     * The ids the Run's other claim may have (siblingKeysOf). A cell that lists
     * one holds that side already: after a hub restart or a new session the
     * book has no record of admitting it, and would make this side wait for it.
     */
    siblingClaimIds?: string[];
}

export type MemoryAdmission =
    /** The cell sends no memory: admitted by slots, as before. */
    | { kind: 'unmetered' }
    | { kind: 'admitted'; needMb: number; siblingMb: number }
    /** Not now: wait and ask again. */
    | { kind: 'wait'; needMb: number; freeMb: number; allocatableMb: number; ahead: number }
    /** Never on this cell: the claim alone is more than the cell may commit. */
    | { kind: 'too_large'; needMb: number; allocatableMb: number };

type Held = { mb: number; runId?: string; side: string; at: number; listed: boolean };
type SetAside = { runId: string; side: string; mb: number; at: number };
type Waiter = { firstAt: number; seenAt: number; runId?: string };
type TicketHold = {
    ref: PhysicalAdmissionTicket;
    bootMb: number;
    cancelled: boolean;
    pinnedUntil?: number;
    members: Map<
        string,
        {
            started: boolean;
            listed: boolean;
            gone: boolean;
            releasedAt?: number;
        }
    >;
};
type CellState = {
    epoch?: string;
    reportedAt?: number;
    freeSlots?: number;
    tickets: Map<string, TicketHold>;
    report?: HeartbeatMemory; listed: ReadonlySet<string>; held: Map<string, Held>; setAside: SetAside[]; waiters: Map<string, Waiter> };

const otherSide = (side: string) =>
    side === 'base' ? 'pr' : side === 'pr' ? 'base' : undefined;

/**
 * A Run claim's key is `<runId>:<side>:<attempt>`, plus `:renewed` for a side
 * booted again on a fresh claim (run-orchestrator acquire): the keys the other
 * side may hold, or none for any other claim.
 */
export const siblingKeysOf = (runId: string | null | undefined, idempotencyKey: string): string[] => {
    if (!runId || !idempotencyKey.startsWith(`${runId}:`)) return [];
    const [side, attempt, ...rest] = idempotencyKey.slice(runId.length + 1).split(':');
    const other = otherSide(side);
    if (!other || !attempt || rest.length > 1 || (rest.length === 1 && rest[0] !== 'renewed')) return [];
    return [`${runId}:${other}:${attempt}`, `${runId}:${other}:${attempt}:renewed`];
};

export class CellMemoryBook {
    private readonly cells = new Map<string, CellState>();

    private state(cellId: string): CellState {
        let s = this.cells.get(cellId);
        if (!s) {
            s = {
                tickets: new Map(),
                listed: new Set(), held: new Map(), setAside: [], waiters: new Map() };
            this.cells.set(cellId, s);
        }
        return s;
    }

    /** A new session (hello): what the old one admitted is the cell's to report now. */
    reset(cellId: string, epoch?: string): void {
        this.cells.delete(cellId);
        if (epoch) this.state(cellId).epoch = epoch;
    }

    /**
     * A heartbeat: the cell's memory (absent from a cell that sends none) and
     * the claims it holds. A claim it lists is in its committed memory from
     * now on; one it listed and no longer does is gone.
     */
    report(cellId: string, memory: HeartbeatMemory | undefined, claims: readonly string[], now: number,
        freeSlots?: number,
        epoch?: string,
    ): void {
        const s = this.state(cellId);
        if (epoch && s.epoch !== epoch) return;
        s.reportedAt = now;
        s.freeSlots = freeSlots;
        s.report = memory;
        const listed = new Set(claims);
        s.listed = listed;
        for (const t of s.tickets.values())
            for (const [id, m] of t.members) {
                if (listed.has(id)) m.listed = true;
                else if (
                    m.listed ||
                    (m.releasedAt !== undefined && now > m.releasedAt)
                )
                    m.gone = true;
            }
        for (const [id, h] of s.held) {
            if (listed.has(id)) h.listed = true;
            else if (h.listed || now - h.at > UNLISTED_TTL_MS) s.held.delete(id);
        }
        this.prune(s, now);
    }

    /** The hub's round of a claim ended before the cell took it (refused, unanswered, failed, released). */
    forget(cellId: string, claimId: string): void {
        const s = this.cells.get(cellId);
        const h = s?.held.get(claimId);
        if (!s || !h) return;
        s.held.delete(claimId);
        // The other side's memory was set aside for this Run: with no claim of it left here, nothing comes to take it.
        if (h.runId && ![...s.held.values()].some((x) => x.runId === h.runId)) s.setAside = s.setAside.filter((x) => x.runId !== h.runId);
    }

    /** What a claim is counted for while it boots, by the cell's report: the base of a Run at its ready size (it boots from the bake). */
    private needOf(r: HeartbeatMemory, c: Pick<MemoryClaim, 'side' | 'consumer' | 'sizeMb'>): number {
        const boot = c.sizeMb && c.sizeMb > 0 ? c.sizeMb : r.bootMb;
        return c.consumer === 'runtime' && c.side === 'base' ? Math.min(boot, r.readyMb) : boot;
    }

    /** Admits the claim on the cell if it fits now and nobody who asked first still waits (see the file comment). */
    admit(cellId: string, c: MemoryClaim, now: number): MemoryAdmission {
        const s = this.state(cellId);
        const r = s.report;
        this.prune(s, now);
        if (!r) {
            if (
                s.freeSlots !== undefined &&
                !s.held.has(c.claimId) &&
                !s.listed.has(c.claimId)
            ) {
                if (s.freeSlots <= this.pendingSlots(s))
                    return {
                        kind: 'wait',
                        needMb: 0,
                        freeMb: 0,
                        allocatableMb: 0,
                        ahead: 0,
                    };
                s.held.set(c.claimId, {
                    mb: 0,
                    runId: c.runId ?? undefined,
                    side: c.side,
                    at: now,
                    listed: false,
                });
            }
            return { kind: 'unmetered' };
        }
        if (s.held.has(c.claimId)) return { kind: 'admitted', needMb: s.held.get(c.claimId)!.mb, siblingMb: 0 };
        // The cell holds it already (a retry after this replica restarted): its memory is in the cell's committed.
        if (s.listed.has(c.claimId)) return { kind: 'admitted', needMb: 0, siblingMb: 0 };
        const runId = c.runId ?? undefined;
        const hold = (needMb: number, siblingMb: number): MemoryAdmission => {
            s.held.set(c.claimId, { mb: needMb, runId, side: c.side, at: now, listed: false });
            s.waiters.delete(c.claimId);
            return { kind: 'admitted', needMb, siblingMb };
        };
        // The other side of a Run admitted here: its memory was set aside then, so it never waits.
        const mine = runId ? s.setAside.findIndex((x) => x.runId === runId && x.side === c.side) : -1;
        if (mine >= 0) {
            const [aside] = s.setAside.splice(mine, 1);
            return hold(Math.max(aside.mb, this.needOf(r, c)), 0);
        }
        const needMb = this.needOf(r, c);
        if (needMb > r.allocatableMb) return { kind: 'too_large', needMb, allocatableMb: r.allocatableMb };
        // A Run's two claims are admitted together: the first sets the other's memory aside, so two
        // Runs never each hold a base while both PR builds wait for memory the bases hold.
        const other = otherSide(c.side);
        const runHere =
            !!runId && ([...s.held.values()].some((h) => h.runId === runId) || s.setAside.some((x) => x.runId === runId) || !!c.siblingClaimIds?.some((id) => s.listed.has(id)));
        let siblingMb = c.consumer === 'runtime' && runId && other && !runHere ? this.needOf(r, { ...c, side: other, sizeMb: c.sizeMb }) : 0;
        // A cell too small for both at once still takes them one after the other.
        if (needMb + siblingMb > r.allocatableMb) siblingMb = 0;
        const freeMb = r.allocatableMb - r.committedMb - this.pendingMb(s);
        const waiter = s.waiters.get(c.claimId);
        const firstAt = waiter?.firstAt ?? now;
        // A Run that already holds memory here goes before every Run that holds none: making it wait
        // behind one deadlocks the cell (cell-dev-1: Run 1's base was ready and its PR fit, but Run 2,
        // which needed Run 1 to finish, asked first after the cell refused Run 1's PR once).
        const ahead = runHere
            ? 0
            : [...s.waiters.entries()].filter(([id, w]) => id !== c.claimId && w.firstAt < firstAt && !(runId && w.runId === runId)).length;
        if (!ahead && needMb + siblingMb <= freeMb &&
            (s.freeSlots === undefined || s.freeSlots > this.pendingSlots(s))
        ) {
            if (siblingMb) s.setAside.push({ runId: runId!, side: other!, mb: siblingMb, at: now });
            return hold(needMb, siblingMb);
        }
        s.waiters.set(c.claimId, { firstAt, seenAt: now, runId });
        return { kind: 'wait', needMb: needMb + siblingMb, freeMb: Math.max(0, freeMb), allocatableMb: r.allocatableMb, ahead };
    }

    /**
     * What the claim is counted for while it boots and once ready, and what the
     * cell may commit in all, by the cell's last report: the facts the Run's
     * cost is priced from (claim metering). A sized claim is counted at the
     * smaller of its size and readyMb once ready (HeartbeatMemorySchema).
     * Null when the cell sends no memory.
     */
    sizesOf(cellId: string, c: Pick<MemoryClaim, 'side' | 'consumer' | 'sizeMb'>): { bootMb: number; readyMb: number; allocatableMb: number } | null {
        const r = this.cells.get(cellId)?.report;
        if (!r) return null;
        const bootMb = this.needOf(r, c);
        return { bootMb, readyMb: Math.min(bootMb, r.readyMb), allocatableMb: r.allocatableMb };
    }

    /** What this replica admitted that the cell's last report does not hold yet, and what is set aside. */
    private pendingMb(s: CellState): number {
        let n = 0;
        for (const h of s.held.values()) if (!h.listed) n += h.mb;
        for (const x of s.setAside) n += x.mb;
        for (const t of s.tickets.values()) {
            for (const [id, m] of t.members)
                if (!m.gone && !s.listed.has(id) && !s.held.has(id))
                    n += t.bootMb;
            if (this.setupIdle(t)) n += t.bootMb;
        }
        return n;
    }

    private prune(s: CellState, now: number) {
        for (const [id, t] of s.tickets) {
            const until = t.pinnedUntil ?? Date.parse(t.ref.expiresAt);
            if (now >= until) for (const m of t.members.values()) m.gone = true;
            if (
                [...t.members.values()].every((m) => m.gone) &&
                (t.cancelled || now >= until || t.ref.kind !== 'setup')
            )
                s.tickets.delete(id);
        }
        for (const [id, h] of s.held) if (!h.listed && now - h.at > UNLISTED_TTL_MS) s.held.delete(id);
        s.setAside = s.setAside.filter((x) => now - x.at <= SIBLING_TTL_MS);
        for (const [id, w] of s.waiters) if (now - w.seenAt > WAITER_TTL_MS) s.waiters.delete(id);
    }

    private pendingSlots(s: CellState): number {
        let n = [...s.held.keys()].filter((id) => !s.listed.has(id)).length;
        for (const t of s.tickets.values()) {
            for (const [id, m] of t.members)
                if (!m.gone && !s.listed.has(id) && !s.held.has(id)) n++;
            if (this.setupIdle(t)) n++;
        }
        return n;
    }

    /** Strict cold budgets, reserved synchronously in the same book legacy claims read. */
    reserveTicket(
        ref: PhysicalAdmissionTicket,
        sizeMb: number | undefined,
        now: number,
        allowUnmetered = false,
    ): PhysicalAdmissionResult {
        const s = this.state(ref.cellId);
        this.prune(s, now);
        const refused = (
            reason:
                | 'unavailable'
                | 'pair_too_large'
                | 'no_capacity'
                | 'owner_changed'
                | 'size_unavailable',
            retryable = true,
        ): PhysicalAdmissionResult => ({
            status: 'refused',
            reason,
            retryable,
        });
        if (
            s.epoch !== ref.sessionEpoch ||
            (!s.report && !allowUnmetered) ||
            s.reportedAt === undefined ||
            now - s.reportedAt > 30_000 ||
            s.freeSlots === undefined
        )
            return refused('unavailable');
        const existing = s.tickets.get(ref.ticketId);
        if (existing)
            return this.sameTicket(existing.ref, ref)
                ? { status: 'reserved', ticket: existing.ref }
                : refused('owner_changed', false);
        if (Date.parse(ref.expiresAt) <= now) return refused('unavailable');
        const bootMb = s.report ? (sizeMb ?? s.report.bootMb) : 0;
        const need = bootMb * ref.members.length;
        if (s.report && need > s.report.allocatableMb)
            return refused(
                ref.kind === 'run' ? 'pair_too_large' : 'size_unavailable',
                false,
            );
        const ids = ref.members.map((m) => m.claimId);
        if (
            ids.some(
                (id) =>
                    s.listed.has(id) ||
                    s.held.has(id) ||
                    [...s.tickets.values()].some((t) => t.members.has(id)),
            )
        )
            return refused('owner_changed', false);
        if (
            s.tickets.size >= 1024 ||
            (s.report &&
                need >
                    s.report.allocatableMb -
                        s.report.committedMb -
                        this.pendingMb(s)) ||
            ref.members.length > s.freeSlots - this.pendingSlots(s)
        )
            return refused('no_capacity');
        const ticket = structuredClone(ref);
        s.tickets.set(ticket.ticketId, {
            ref: ticket,
            bootMb,
            cancelled: false,
            members: new Map(
                ids.map((id) => [
                    id,
                    { started: false, listed: false, gone: false },
                ]),
            ),
        });
        return { status: 'reserved', ticket };
    }

    findTicket(
        cellId: string,
        identity: Pick<
            PhysicalAdmissionTicket,
            | 'organizationId'
            | 'kind'
            | 'key'
            | 'generation'
            | 'ticketOwnerToken'
        >,
    ): PhysicalAdmissionTicket | undefined {
        for (const t of this.cells.get(cellId)?.tickets.values() ?? [])
            if (
                !t.cancelled &&
                t.ref.organizationId === identity.organizationId &&
                t.ref.kind === identity.kind &&
                t.ref.key === identity.key &&
                t.ref.generation === identity.generation &&
                t.ref.ticketOwnerToken === identity.ticketOwnerToken
            )
                return structuredClone(t.ref);
        return undefined;
    }

    private sameTicket(
        a: PhysicalAdmissionTicket,
        b: PhysicalAdmissionTicket,
    ): boolean {
        return (
            a.ticketId === b.ticketId &&
            a.cellId === b.cellId &&
            a.sessionEpoch === b.sessionEpoch &&
            a.organizationId === b.organizationId &&
            a.kind === b.kind &&
            a.key === b.key &&
            a.generation === b.generation &&
            a.ticketOwnerToken === b.ticketOwnerToken &&
            a.expiresAt === b.expiresAt &&
            JSON.stringify(a.members) === JSON.stringify(b.members)
        );
    }

    ticketOf(ref: PhysicalAdmissionTicket): TicketHold | undefined {
        const s = this.cells.get(ref.cellId);
        const t = s?.tickets.get(ref.ticketId);
        return t && s?.epoch === ref.sessionEpoch && this.sameTicket(t.ref, ref)
            ? t
            : undefined;
    }

    ticketMemberReserved(cellId: string, claimId: string): boolean {
        return [...(this.cells.get(cellId)?.tickets.values() ?? [])].some(
            (t) => t.members.has(claimId) && !t.members.get(claimId)!.gone,
        );
    }

    /** A whole ticket is validated before either side starts; pinning never extends a cell's claim ceiling. */
    redeemTicket(ref: PhysicalAdmissionTicket, now: number): boolean {
        const t = this.ticketOf(ref);
        if (
            !t ||
            t.cancelled ||
            now >= (t.pinnedUntil ?? Date.parse(t.ref.expiresAt))
        )
            return false;
        t.pinnedUntil ??= now + 60 * 60_000;
        return true;
    }

    validTicketMember(
        ref: PhysicalAdmissionTicket,
        claimId: string,
        now: number,
    ): boolean {
        const t = this.ticketOf(ref);
        const m = t?.members.get(claimId);
        return (
            !!t &&
            !t.cancelled &&
            t.pinnedUntil !== undefined &&
            now < t.pinnedUntil &&
            !!m &&
            !m.gone
        );
    }

    /** Conversion keeps the same boot debit; a cold base never takes the legacy ready-size discount. */
    prepareTicketMember(
        ref: PhysicalAdmissionTicket,
        claimId: string,
        now: number,
    ): boolean {
        if (!this.validTicketMember(ref, claimId, now)) return false;
        const s = this.cells.get(ref.cellId)!;
        const t = this.ticketOf(ref)!;
        if (!s.listed.has(claimId))
            s.held.set(claimId, {
                mb: t.bootMb,
                runId: ref.kind === 'run' ? ref.key : undefined,
                side:
                    ref.kind === 'setup'
                        ? 'setup'
                        : ref.members.find((m) => m.claimId === claimId)!.side,
                at: now,
                listed: false,
            });
        s.waiters.delete(claimId);
        return true;
    }

    consumeTicket(
        ref: PhysicalAdmissionTicket,
        claimId: string,
        now: number,
    ): boolean {
        if (!this.prepareTicketMember(ref, claimId, now)) return false;
        this.ticketOf(ref)!.members.get(claimId)!.started = true;
        return true;
    }

    /** Started shadows survive legacy forget and cancellation until authoritative listing/absence or hard ceiling. */
    cancelTicket(ref: PhysicalAdmissionTicket, _now: number): void {
        const t = this.ticketOf(ref);
        if (!t) return;
        t.cancelled = true;
        for (const m of t.members.values()) if (!m.started) m.gone = true;
    }

    private setupIdle(t: TicketHold): boolean {
        return (
            t.ref.kind === 'setup' &&
            !t.cancelled &&
            [...t.members.values()].every((m) => m.gone)
        );
    }

    startedMembers(ref: PhysicalAdmissionTicket): string[] {
        return [...(this.ticketOf(ref)?.members.entries() ?? [])]
            .filter(([, m]) => m.started)
            .map(([id]) => id);
    }

    cleanupPending(ref: PhysicalAdmissionTicket): boolean {
        return [...(this.ticketOf(ref)?.members.values() ?? [])].some((m) => m.started && !m.gone);
    }

    noteReleased(cellId: string, claimId: string, now: number): void {
        for (const t of this.cells.get(cellId)?.tickets.values() ?? []) {
            const member = t.members.get(claimId);
            if (member) member.releasedAt = now;
        }
    }

    canRetargetSetup(
        ref: PhysicalAdmissionTicket,
        idempotencyKey: string,
        now: number,
    ): 'ok' | 'member_cleanup_pending' | 'owner_changed' | 'ticket_expired' {
        const t = this.ticketOf(ref);
        const s = this.cells.get(ref.cellId);
        if (!t || !s || t.cancelled || ref.kind !== 'setup')
            return 'owner_changed';
        if (!t.pinnedUntil || now >= t.pinnedUntil) return 'ticket_expired';
        const prefix = `setup:${ref.key}`;
        const suffix = idempotencyKey.slice(prefix.length);
        if (
            !idempotencyKey.startsWith(prefix) ||
            (suffix !== '' && !/^:learn-[1-3](-replay)?$/.test(suffix))
        )
            return 'owner_changed';
        const next = claimIdFor(ref.organizationId, idempotencyKey);
        if (t.members.has(next))
            return t.members.get(next)!.gone ? 'owner_changed' : 'ok';
        if (t.members.size >= 16) return 'owner_changed';
        for (const [id, m] of t.members)
            if (
                !m.gone ||
                m.releasedAt === undefined ||
                s.reportedAt === undefined ||
                s.reportedAt <= m.releasedAt ||
                s.listed.has(id)
            )
                return 'member_cleanup_pending';
        return 'ok';
    }

    retargetSetup(
        ref: PhysicalAdmissionTicket,
        idempotencyKey: string,
        now: number,
    ): boolean {
        if (this.canRetargetSetup(ref, idempotencyKey, now) !== 'ok')
            return false;
        const t = this.ticketOf(ref)!;
        const id = claimIdFor(ref.organizationId, idempotencyKey);
        if (!t.members.has(id))
            t.members.set(id, { started: false, listed: false, gone: false });
        return true;
    }

    /** The cell's memory as this replica sees it, for logs and tests. */
    view(cellId: string): { allocatableMb: number; committedMb: number; pendingMb: number; waiting: number } | null {
        const s = this.cells.get(cellId);
        if (!s?.report) return null;
        return { allocatableMb: s.report.allocatableMb, committedMb: s.report.committedMb, pendingMb: this.pendingMb(s), waiting: s.waiters.size };
    }
}
