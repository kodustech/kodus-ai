import type { CapacityNumbers, SandboxCapacityStore } from './sandbox-capacity-gate';

/**
 * In-memory twin of MongoCapacityStore for specs. Each method is synchronous
 * inside, like one atomic Mongo operation; two gates over one instance are
 * two workers over one database.
 */
export class FakeCapacityStore implements SandboxCapacityStore {
    readonly tickets: {
        id: string;
        prKey: string;
        createdAt: Date;
        heartbeatAt: Date;
        seq: number;
    }[] = [];
    slots: { ticketId: string; heartbeatAt: Date }[] = [];
    private seq = 0;

    async enqueue(t: { id: string; prKey: string }, now: Date) {
        this.tickets.push({ ...t, createdAt: now, heartbeatAt: now, seq: this.seq++ });
    }
    async touch(id: string, now: Date) {
        const t = this.tickets.find((x) => x.id === id);
        if (t) t.heartbeatAt = now;
        return !!t;
    }
    private live(deadBefore: Date) {
        return this.tickets
            .filter((t) => t.heartbeatAt >= deadBefore)
            .sort((a, b) => +a.createdAt - +b.createdAt || a.seq - b.seq);
    }
    async isHead(id: string, deadBefore: Date) {
        return this.live(deadBefore)[0]?.id === id;
    }
    async tryAdmit(id: string, cap: number, now: Date, deadBefore: Date) {
        this.slots = this.slots.filter((s) => s.heartbeatAt >= deadBefore);
        if (this.slots.length >= cap) return false;
        this.slots.push({ ticketId: id, heartbeatAt: now });
        this.removeSync(id);
        return true;
    }
    async heartbeatSlot(id: string, now: Date) {
        const s = this.slots.find((x) => x.ticketId === id);
        if (s) s.heartbeatAt = now;
    }
    async releaseSlot(id: string) {
        this.slots = this.slots.filter((s) => s.ticketId !== id);
    }
    private removeSync(id: string) {
        const i = this.tickets.findIndex((t) => t.id === id);
        if (i !== -1) this.tickets.splice(i, 1);
    }
    async removeTicket(id: string) {
        this.removeSync(id);
    }
    async removeTicketsByPrKey(prKey: string) {
        const ids = this.tickets.filter((t) => t.prKey === prKey).map((t) => t.id);
        ids.forEach((i) => this.removeSync(i));
        return ids.length;
    }
    async numbers(deadBefore: Date): Promise<CapacityNumbers> {
        const live = this.live(deadBefore);
        return {
            inUse: this.slots.filter((s) => s.heartbeatAt >= deadBefore).length,
            queued: live.length,
            oldestCreatedAt: live[0]?.createdAt ?? null,
        };
    }
}
