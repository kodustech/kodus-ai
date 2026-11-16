import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';

import { GetRuntimeMachineMinutesUseCase, UpdateRuntimeMachineMinutesUseCase } from '../application/use-cases/settings.use-cases';
import type { RuntimeMachineUsageReader } from '../domain/ports';
import type { RuntimeMachineUsageToday } from '../domain/machine-minutes-today';
import { config, FakeOutbox, ORG, user } from './fixtures';

// Spec v18 PR 2 "teto de minutos de execução por org": the org admin sets the org's own daily machine minutes,
// below the deployment's RUNTIME_MACHINE_MINUTES_PER_ORG_DAY; the hub refuses the claims past it.

const NOW = new Date('2026-11-16T10:00:00.000Z');
const clock = () => NOW;

class Usage implements RuntimeMachineUsageReader {
    readonly asked: string[] = [];
    constructor(private readonly byOrg: Record<string, RuntimeMachineUsageToday>) {}
    async today(organizationId: string) {
        this.asked.push(organizationId);
        return this.byOrg[organizationId] ?? { seconds: 0, heldSeconds: 0, openRounds: 0, orgLimitMinutes: null };
    }
}

describe("the org's own daily machine minutes", () => {
    it("shows the org's own limit as today's limit when it is below the deployment's", async () => {
        const usage = new Usage({ [ORG]: { seconds: 100 * 60, heldSeconds: 80 * 60, openRounds: 1, orgLimitMinutes: 600 } });
        const today = await new GetRuntimeMachineMinutesUseCase(usage, config({ machineMinutesPerOrgDay: 10_000 }), clock).execute({ user: user(Role.OWNER) });
        expect(today).toMatchObject({ limitMinutes: 600, remainingMinutes: 500, orgLimitMinutes: 600, deploymentLimitMinutes: 10_000, limitSource: 'org' });
        expect(usage.asked).toEqual([ORG]);
    });

    it("shows the deployment's limit when the org set none or set one above it", async () => {
        const none = new Usage({ [ORG]: { seconds: 0, heldSeconds: 0, openRounds: 0, orgLimitMinutes: null } });
        expect(await new GetRuntimeMachineMinutesUseCase(none, config({ machineMinutesPerOrgDay: 1_000 }), clock).execute({ user: user(Role.OWNER) })).toMatchObject({
            limitMinutes: 1_000,
            orgLimitMinutes: null,
            limitSource: 'deployment',
        });
        const above = new Usage({ [ORG]: { seconds: 0, heldSeconds: 0, openRounds: 0, orgLimitMinutes: 5_000 } });
        expect(await new GetRuntimeMachineMinutesUseCase(above, config({ machineMinutesPerOrgDay: 1_000 }), clock).execute({ user: user(Role.OWNER) })).toMatchObject({
            limitMinutes: 1_000,
            orgLimitMinutes: 5_000,
            limitSource: 'deployment',
        });
    });

    it("sends the caller's org its new limit as a command, and null to go back to the deployment's", async () => {
        const outbox = new FakeOutbox();
        const update = new UpdateRuntimeMachineMinutesUseCase(outbox as any, clock);
        expect(await update.execute({ user: user(Role.OWNER), body: { minutesPerDay: 600 } })).toEqual({ minutesPerDay: 600, changedAt: NOW.toISOString() });
        await update.execute({ user: user(Role.OWNER, { org: 'org-b' }), body: { minutesPerDay: null } });
        const sent = outbox.rows.map((r) => r.payload);
        expect(sent[0]).toMatchObject({ event_name: 'runtime.org.machine_minutes_changed', payload: { organizationId: ORG, minutesPerDay: 600, changedBy: { userId: `user-${Role.OWNER}` } } });
        expect(sent[1]).toMatchObject({ payload: { organizationId: 'org-b', minutesPerDay: null } });
    });

    it('refuses a limit that is not a positive whole number of minutes, sending nothing', async () => {
        const outbox = new FakeOutbox();
        const update = new UpdateRuntimeMachineMinutesUseCase(outbox as any, clock);
        for (const minutesPerDay of [0, -1, 2.5, '600', undefined, 14_400_001]) {
            await expect(update.execute({ user: user(Role.OWNER), body: { minutesPerDay } })).rejects.toThrow('minutesPerDay');
        }
        expect(outbox.rows).toEqual([]);
    });
});
