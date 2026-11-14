import { CellMemoryBook, siblingKeysOf, WAITER_TTL_MS } from './cell-memory';

// cell-dev-1 (ADR-070): 15 GB less the reserve, claims at -gvisor-mem-limit 12g, ready at 2g.
const report = (committedMb: number) => ({ allocatableMb: 14_745, committedMb, bootMb: 12_288, readyMb: 2_048 });
const claim = (run: string, side: 'base' | 'pr') => ({ claimId: `${run}:${side}`, runId: run, side, consumer: 'runtime' as const });

describe('CellMemoryBook', () => {
    it('a cell that sends no memory is admitted by slots, as before', () => {
        const book = new CellMemoryBook();
        expect(book.admit('cell', claim('r1', 'pr'), 0)).toEqual({ kind: 'unmetered' });
        book.report('cell', undefined, [], 0);
        expect(book.admit('cell', claim('r1', 'pr'), 0)).toEqual({ kind: 'unmetered' });
    });

    it('the incident: a second Run waits instead of building next to the first, and goes once the first is done', () => {
        const book = new CellMemoryBook();
        book.report('cell', report(0), [], 0);
        // Run 1: its base boots from the bake (ready size) and its PR builds (build size); both fit.
        expect(book.admit('cell', claim('r1', 'base'), 1)).toEqual({ kind: 'admitted', needMb: 2_048, siblingMb: 12_288 });
        expect(book.admit('cell', claim('r1', 'pr'), 2)).toEqual({ kind: 'admitted', needMb: 12_288, siblingMb: 0 });
        book.report('cell', report(14_336), ['r1:base', 'r1:pr'], 3);
        // Run 2, two minutes later: its PR build does not fit next to Run 1's.
        expect(book.admit('cell', claim('r2', 'base'), 120_000)).toMatchObject({ kind: 'wait', needMb: 14_336, freeMb: 409, ahead: 0 });
        expect(book.admit('cell', claim('r2', 'pr'), 120_001)).toMatchObject({ kind: 'wait', ahead: 0 });
        // Run 1's PR is ready (2 GB): still no room for a 12 GB build next to three ready claims.
        book.report('cell', report(4_096), ['r1:base', 'r1:pr'], 130_000);
        expect(book.admit('cell', claim('r2', 'base'), 135_000)).toMatchObject({ kind: 'wait', freeMb: 10_649 });
        // Run 1 released both: Run 2 goes, as a whole.
        book.report('cell', report(0), [], 400_000);
        expect(book.admit('cell', claim('r2', 'base'), 405_000)).toEqual({ kind: 'admitted', needMb: 2_048, siblingMb: 12_288 });
        expect(book.admit('cell', claim('r2', 'pr'), 405_001)).toEqual({ kind: 'admitted', needMb: 12_288, siblingMb: 0 });
    });

    it('two Runs whose bases arrive first never deadlock: the first base sets its PR’s memory aside', () => {
        const book = new CellMemoryBook();
        book.report('cell', report(0), [], 0);
        expect(book.admit('cell', claim('r1', 'base'), 1).kind).toBe('admitted');
        // Run 2's base would fit alone (2 GB), but Run 1's PR build is set aside.
        expect(book.admit('cell', claim('r2', 'base'), 2)).toMatchObject({ kind: 'wait' });
        expect(book.admit('cell', claim('r1', 'pr'), 3)).toEqual({ kind: 'admitted', needMb: 12_288, siblingMb: 0 });
    });

    it('the second incident: a Run whose base holds memory never waits behind a Run that holds none', () => {
        const book = new CellMemoryBook();
        book.report('cell', report(0), [], 0);
        // Run 1's base is admitted and its PR's memory set aside; the cell refuses the PR once
        // (it counted the base at build size: no warm machine), so the hub forgets it.
        expect(book.admit('cell', claim('r1', 'base'), 1).kind).toBe('admitted');
        expect(book.admit('cell', claim('r1', 'pr'), 2).kind).toBe('admitted');
        book.forget('cell', 'r1:pr');
        // Run 2 asks for both sides: they do not fit next to Run 1, so they wait, first in line.
        expect(book.admit('cell', claim('r2', 'base'), 3)).toMatchObject({ kind: 'wait', ahead: 0 });
        expect(book.admit('cell', claim('r2', 'pr'), 4)).toMatchObject({ kind: 'wait', ahead: 0 });
        // Run 1's base is ready (2 GB): its PR fits and goes, ahead of Run 2.
        book.report('cell', report(2_048), ['r1:base'], 10_000);
        expect(book.admit('cell', claim('r1', 'pr'), 10_001)).toEqual({ kind: 'admitted', needMb: 12_288, siblingMb: 0 });
        expect(book.admit('cell', claim('r2', 'base'), 10_002)).toMatchObject({ kind: 'wait' });
    });

    it('after a hub restart, a Run whose base the cell lists is here: its PR goes, ahead of others, with no phantom sibling', () => {
        const book = new CellMemoryBook();
        book.report('cell', report(0), [], 0);
        book.admit('cell', claim('r1', 'base'), 1);
        book.report('cell', report(2_048), ['r1:base'], 2);
        // The hub restarts (or the cell says hello again): the book forgets what it admitted.
        book.reset('cell');
        book.report('cell', report(2_048), ['r1:base'], 3);
        // Run 2 asked first and waits; Run 1's PR, whose base the cell holds, still goes.
        expect(book.admit('cell', claim('r2', 'base'), 4)).toMatchObject({ kind: 'wait' });
        // Without the sibling's id the book charges a phantom base and puts Run 2 ahead: it waits for nothing.
        expect(book.admit('cell', claim('r1', 'pr'), 5)).toMatchObject({ kind: 'wait' });
        expect(book.admit('cell', { ...claim('r1', 'pr'), siblingClaimIds: ['r1:base'] }, 6)).toEqual({ kind: 'admitted', needMb: 12_288, siblingMb: 0 });
    });

    it("siblingKeysOf: the other side's keys of a Run claim, renewed or not; nothing for any other key", () => {
        expect(siblingKeysOf('r1', 'r1:base:1')).toEqual(['r1:pr:1', 'r1:pr:1:renewed']);
        expect(siblingKeysOf('r1', 'r1:pr:2')).toEqual(['r1:base:2', 'r1:base:2:renewed']);
        expect(siblingKeysOf('r1', 'r1:base:1:renewed')).toEqual(['r1:pr:1', 'r1:pr:1:renewed']);
        expect(siblingKeysOf('r1', 'r1:explore:1')).toEqual([]);
        expect(siblingKeysOf('r1', 'r2:base:1')).toEqual([]);
        expect(siblingKeysOf(null, 'mcp:s1')).toEqual([]);
        expect(siblingKeysOf('r1', 'r1:base:1:x')).toEqual([]);
    });

    it('waits in order: a claim that would fit waits behind one that asked first', () => {
        const book = new CellMemoryBook();
        book.report('cell', { ...report(10_000) }, ['other'], 0);
        const big = { claimId: 'setup-1', side: 'setup', consumer: 'setup' as const };
        const small = { claimId: 'session-1', side: 'base', consumer: 'mcp' as const, sizeMb: 2_048 };
        expect(book.admit('cell', big, 1)).toMatchObject({ kind: 'wait', ahead: 0 });
        expect(book.admit('cell', small, 2)).toMatchObject({ kind: 'wait', ahead: 1 });
        book.report('cell', report(0), [], 10);
        expect(book.admit('cell', small, 11)).toMatchObject({ kind: 'wait', ahead: 1 });
        expect(book.admit('cell', big, 12).kind).toBe('admitted');
        expect(book.admit('cell', small, 13).kind).toBe('admitted');
    });

    it('a waiter that stopped asking leaves the line', () => {
        const book = new CellMemoryBook();
        book.report('cell', report(10_000), ['other'], 0);
        expect(book.admit('cell', { claimId: 'gone', side: 'setup', consumer: 'setup' }, 0).kind).toBe('wait');
        book.report('cell', report(0), [], WAITER_TTL_MS + 1);
        expect(book.admit('cell', { claimId: 'next', side: 'setup', consumer: 'setup' }, WAITER_TTL_MS + 2).kind).toBe('admitted');
    });

    it('counts what it admitted until the cell lists it, then the cell’s own report; forgets what the cell dropped', () => {
        const book = new CellMemoryBook();
        book.report('cell', report(0), [], 0);
        book.admit('cell', { claimId: 's1', side: 'setup', consumer: 'setup' }, 1);
        expect(book.view('cell')).toMatchObject({ committedMb: 0, pendingMb: 12_288 });
        book.report('cell', report(12_288), ['s1'], 2);
        expect(book.view('cell')).toMatchObject({ committedMb: 12_288, pendingMb: 0 });
        // A retry of a claim the cell holds is not counted twice.
        expect(book.admit('cell', { claimId: 's1', side: 'setup', consumer: 'setup' }, 3).kind).toBe('admitted');
        book.report('cell', report(0), [], 4);
        expect(book.view('cell')).toMatchObject({ committedMb: 0, pendingMb: 0 });
        // A round the cell refused is forgotten at once.
        book.admit('cell', { claimId: 's2', side: 'setup', consumer: 'setup' }, 5);
        book.forget('cell', 's2');
        expect(book.view('cell')).toMatchObject({ pendingMb: 0 });
    });

    it("a base whose round failed takes its PR's set-aside memory with it", () => {
        const book = new CellMemoryBook();
        book.report('cell', report(0), [], 0);
        expect(book.admit('cell', claim('r1', 'base'), 1)).toMatchObject({ kind: 'admitted', siblingMb: 12_288 });
        // Run 2's base would wait behind Run 1's set-aside PR build...
        expect(book.admit('cell', claim('r2', 'base'), 2)).toMatchObject({ kind: 'wait' });
        // ...until Run 1's base fails before the cell takes it: no claim of Run 1 is left to use that memory.
        book.forget('cell', 'r1:base');
        expect(book.admit('cell', claim('r2', 'base'), 3)).toMatchObject({ kind: 'admitted' });
    });

    it('a claim larger than the cell never waits; a cell too small for a whole Run takes its claims one after the other', () => {
        const book = new CellMemoryBook();
        book.report('cell', report(0), [], 0);
        expect(book.admit('cell', { claimId: 'huge', side: 'pr', consumer: 'runtime', runId: 'r', sizeMb: 16_384 }, 1)).toEqual({ kind: 'too_large', needMb: 16_384, allocatableMb: 14_745 });
        book.report('cell', { allocatableMb: 13_000, committedMb: 0, bootMb: 12_288, readyMb: 2_048 }, [], 2);
        expect(book.admit('cell', claim('r1', 'pr'), 3)).toEqual({ kind: 'admitted', needMb: 12_288, siblingMb: 0 });
    });
});

describe('session-fenced physical tickets', () => {
    const identity = {
        organizationId: 'org-a',
        kind: 'run',
        key: 'run-a',
        generation: 1,
        ticketOwnerToken: 'owner-a',
    };
    const ticket = {
        ...identity,
        ticketId: 'ticket-a',
        cellId: 'cell',
        sessionEpoch: 'epoch-a',
        expiresAt: new Date(120_000).toISOString(),
        members: [
            { side: 'base', idempotencyKey: 'base', claimId: 'base' },
            { side: 'pr', idempotencyKey: 'pr', claimId: 'pr' },
        ],
    };
    const book = (allocatableMb = 32_768) => {
        const b: any = new CellMemoryBook();
        b.reset('cell', 'epoch-a');
        b.report(
            'cell',
            { allocatableMb, committedMb: 0, bootMb: 12_288, readyMb: 2_048 },
            [],
            0,
            4,
            'epoch-a',
        );
        return b;
    };
    it('reserves both cold boot budgets and blocks legacy acquires from taking their room', () => {
        const b = book();
        expect(b.reserveTicket(ticket, undefined, 1)).toMatchObject({
            status: 'reserved',
        });
        expect(b.view('cell').pendingMb).toBe(24_576);
        expect(
            b.admit(
                'cell',
                { claimId: 'setup', side: 'setup', consumer: 'setup' },
                2,
            ).kind,
        ).toBe('wait');
    });
    it('refuses a cold pair larger than the cell without taking either member', () => {
        const b = book(14_745);
        expect(b.reserveTicket(ticket, undefined, 1)).toEqual({
            status: 'refused',
            reason: 'pair_too_large',
            retryable: false,
        });
        expect(b.view('cell').pendingMb).toBe(0);
    });
    it('replaces converted holds with heartbeat accounting and retains started shadows after forget/cancel', () => {
        const b = book();
        b.reserveTicket(ticket, undefined, 1);
        expect(b.redeemTicket(ticket, 2)).toBe(true);
        expect(b.consumeTicket(ticket, 'base', 3)).toBe(true);
        b.forget('cell', 'base');
        b.cancelTicket(ticket, 4);
        expect(b.view('cell').pendingMb).toBe(12_288);
        b.report(
            'cell',
            {
                allocatableMb: 32_768,
                committedMb: 12_288,
                bootMb: 12_288,
                readyMb: 2_048,
            },
            ['base'],
            5,
            3,
            'epoch-a',
        );
        expect(b.view('cell').pendingMb).toBe(0);
        b.report(
            'cell',
            {
                allocatableMb: 32_768,
                committedMb: 0,
                bootMb: 12_288,
                readyMb: 2_048,
            },
            [],
            6,
            4,
            'epoch-a',
        );
        expect(b.view('cell').pendingMb).toBe(0);
    });
    it('keeps a started unlisted shadow past the short ticket TTL until its hard ceiling', () => {
        const b = book(); b.reserveTicket(ticket, undefined, 1); b.redeemTicket(ticket, 2); b.consumeTicket(ticket, 'base', 3);
        b.forget('cell', 'base'); b.cancelTicket(ticket, 4);
        b.report('cell', { allocatableMb: 32_768, committedMb: 0, bootMb: 12_288, readyMb: 2_048 }, [], 300_000, 4, 'epoch-a');
        expect(b.view('cell').pendingMb).toBe(12_288);
        b.report('cell', { allocatableMb: 32_768, committedMb: 0, bootMb: 12_288, readyMb: 2_048 }, [], 3_600_003, 4, 'epoch-a');
        expect(b.view('cell').pendingMb).toBe(0);
    });
    it('fails closed on missing heartbeat, ticket expiry and session replacement', () => {
        const b: any = new CellMemoryBook();
        b.reset('cell', 'epoch-a');
        expect(b.reserveTicket(ticket, undefined, 1).status).toBe('refused');
        const warm = book();
        warm.reserveTicket(ticket, undefined, 1);
        expect(warm.redeemTicket(ticket, 120_001)).toBe(false);
        const replaced = book();
        replaced.reserveTicket(ticket, undefined, 1);
        replaced.reset('cell', 'epoch-b');
        expect(replaced.redeemTicket(ticket, 2)).toBe(false);
    });
});

describe('setup ticket lifetime reservation', () => {
    const key = 'environment:requested-at';
    const initial = `setup:${key}`;
    const id = (s: string) =>
        require('../../shared/claim-id').claimIdFor('org-a', s);
    const ticket: any = {
        organizationId: 'org-a',
        kind: 'setup',
        key,
        generation: 1,
        ticketOwnerToken: 'owner',
        ticketId: 'ticket',
        cellId: 'cell',
        sessionEpoch: 'epoch',
        expiresAt: new Date(120_000).toISOString(),
        members: [
            { side: 'setup', idempotencyKey: initial, claimId: id(initial) },
        ],
    };
    const memory = {
        allocatableMb: 14_745,
        committedMb: 0,
        bootMb: 12_288,
        readyMb: 2_048,
    };
    it('requires release acknowledgement and later absence, preserving the idle boot budget and slot', () => {
        const b = new CellMemoryBook();
        b.reset('cell', 'epoch');
        b.report('cell', memory, [], 0, 1, 'epoch');
        b.reserveTicket(ticket, undefined, 1);
        b.redeemTicket(ticket, 2);
        b.consumeTicket(ticket, id(initial), 3);
        b.forget('cell', id(initial));
        b.report('cell', memory, [], 4, 1, 'epoch');
        expect(b.canRetargetSetup(ticket, `${initial}:learn-1`, 5)).toBe(
            'member_cleanup_pending',
        );
        b.noteReleased('cell', id(initial), 6);
        expect(b.canRetargetSetup(ticket, `${initial}:learn-1`, 7)).toBe(
            'member_cleanup_pending',
        );
        b.report('cell', memory, [], 8, 1, 'epoch');
        expect(b.view('cell')?.pendingMb).toBe(12_288);
        expect(
            b.admit(
                'cell',
                {
                    claimId: 'other',
                    side: 'setup',
                    consumer: 'setup',
                    sizeMb: 1_024,
                },
                9,
            ).kind,
        ).toBe('wait');
        expect(b.retargetSetup(ticket, `${initial}:learn-1`, 10)).toBe(true);
        expect(b.view('cell')?.pendingMb).toBe(12_288);
        expect(b.consumeTicket(ticket, id(`${initial}:learn-1`), 11)).toBe(
            true,
        );
        expect(b.startedMembers(ticket)).toEqual([
            id(initial),
            id(`${initial}:learn-1`),
        ]);
        expect(
            b.canRetargetSetup(ticket, `${initial}:learn-1-replay`, 12),
        ).toBe('member_cleanup_pending');
        for (const bad of [
            `${initial}:learn-4`,
            `${initial}:learn-1:evil`,
            `setup:other:learn-1`,
        ])
            expect(b.canRetargetSetup(ticket, bad, 12)).toBe('owner_changed');
        b.forget('cell', id(`${initial}:learn-1`));
        b.cancelTicket(ticket, 13);
        expect(b.view('cell')?.pendingMb).toBe(12_288);
    });
});
