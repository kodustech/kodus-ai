import { MachineMinutesChangedHandler } from './command-handlers';
import { InMemoryCommandStore } from '../../shared/persistence/testing';

// Spec v18 PR 2 "teto de minutos de execução por org": the org admin's own daily machine minutes reach the
// Runtime Postgres, where the hub reads them under the org day's lock on every claim round.

const changed = (over: Record<string, unknown> = {}) => ({
    organizationId: 'org-a', minutesPerDay: 600, changedBy: { userId: 'owner-1' }, changedAt: '2026-11-16T10:00:00.000Z', key: 'machine-minutes:org-a:1', ...over,
});

describe('runtime.org.machine_minutes_changed', () => {
    it("records the org's own daily machine minutes", async () => {
        const commands = new InMemoryCommandStore();
        expect(await new MachineMinutesChangedHandler(commands).handle(changed())).toBeUndefined();
        expect(await commands.machineMinuteLimit('org-a')).toBe(600);
        expect(await commands.machineMinuteLimit('org-b')).toBeNull();
    });

    it("clears the org's own limit back to the deployment's", async () => {
        const commands = new InMemoryCommandStore();
        const handler = new MachineMinutesChangedHandler(commands);
        await handler.handle(changed());
        await handler.handle(changed({ minutesPerDay: null, changedAt: '2026-11-16T11:00:00.000Z' }));
        expect(await commands.machineMinuteLimit('org-a')).toBeNull();
    });

    it('keeps the newer change when an older one is delivered after it', async () => {
        const commands = new InMemoryCommandStore();
        const handler = new MachineMinutesChangedHandler(commands);
        await handler.handle(changed({ minutesPerDay: 300, changedAt: '2026-11-16T12:00:00.000Z' }));
        await handler.handle(changed({ minutesPerDay: 900, changedAt: '2026-11-16T09:00:00.000Z' }));
        expect(await commands.machineMinuteLimit('org-a')).toBe(300);
    });

    it('refuses a limit that is not a positive whole number of minutes', async () => {
        const commands = new InMemoryCommandStore();
        const handler = new MachineMinutesChangedHandler(commands);
        for (const minutesPerDay of [0, -5, 1.5, '600']) {
            await expect(handler.handle(changed({ minutesPerDay }))).resolves.toMatchObject({ invalid: expect.anything() });
        }
        expect(await commands.machineMinuteLimit('org-a')).toBeNull();
    });
});
