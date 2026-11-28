import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';

import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { DEFAULT_PREVIEW_SETTINGS, type PreviewSettings, previewIdFor, previewSettingsOf } from '@libs/runtime/contracts/preview';

import { ListRuntimeAuditUseCase } from '../application/use-cases/env-audit.use-case';
import { RuntimePreviewSettingsUseCase } from '../application/use-cases/preview-settings.use-cases';
import type { PreviewAuditRecord, RuntimePreviewAuditReader, RuntimePreviewSettingsStore } from '../domain/previews';
import type { UsageClaimRecord } from '../domain/usage-report';
import { NOW, ORG, OTHER_ORG, user } from './fixtures';

// The owner's preview settings and activity (docs/runtime/preview-urls.md §8.4, §6.7).

const owner = user(Role.OWNER);
const other = user(Role.OWNER, { org: OTHER_ORG, uuid: 'other-owner' });

class Settings implements RuntimePreviewSettingsStore {
    readonly rows = new Map<string, PreviewSettings>();
    async getPreviewSettings(org: string) {
        return previewSettingsOf(this.rows.get(org));
    }
    async setPreviewSettings(org: string, s: PreviewSettings) {
        this.rows.set(org, s);
    }
}

const previewClaim = (minutes: number): UsageClaimRecord =>
    ({
        claimId: `c-${minutes}`,
        cellId: 'cell-1',
        runId: null,
        environmentId: 'env-1',
        side: 'pr',
        state: 'released',
        consumer: 'preview',
        repositoryId: 'repo-1',
        driver: null,
        bootMb: null,
        readyMb: null,
        allocatableMb: null,
        admittedAt: new Date(NOW.getTime() - minutes * 60_000).toISOString(),
        readyAt: null,
        releasedAt: NOW.toISOString(),
        stateChangedAt: null,
        hardExpiresAt: null,
        createdAt: NOW.toISOString(),
    }) as UsageClaimRecord;

function setup(opts: { domain?: boolean; usageDown?: boolean; truncated?: boolean } = { domain: true }) {
    const settings = new Settings();
    const usage = {
        previewClaimsOfMonth: async (org: string) => {
            if (opts.usageDown) throw new Error('connection terminated unexpectedly');
            return { claims: org === ORG ? [previewClaim(40), { ...previewClaim(25), consumer: 'runtime' }] : [], truncated: opts.truncated === true };
        },
    };
    const config = opts.domain ? { previewDomain: 'preview.example', previewGrantPrivateKey: 'k' } : {};
    return { settings, service: new RuntimePreviewSettingsUseCase(settings, usage, config, () => NOW) };
}

describe('preview settings', () => {
    it("answer unavailable, not an unknown month's usage, when the usage store cannot be read", async () => {
        const { service } = setup({ domain: true, usageDown: true });
        const error = await service.get({ user: owner }).catch((e) => e);
        expect(error).toBeInstanceOf(ServiceUnavailableException);
        expect(String(error.message)).not.toContain('connection terminated');
    });

    // One read holds a bounded number of claims: a smaller count than the month's would let the cap look further away.
    it('answer unavailable, never a smaller count, when the month has more preview claims than one read holds', async () => {
        const { service } = setup({ domain: true, truncated: true });
        await expect(service.get({ user: owner })).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it("start at the defaults, say whether the deployment serves previews, and count this month's preview time", async () => {
        const { service } = setup();
        expect(await service.get({ user: owner })).toEqual({ available: true, settings: DEFAULT_PREVIEW_SETTINGS, usedMinutesThisMonth: 40 });
        expect((await setup({ domain: false }).service.get({ user: owner })).available).toBe(false);
    });

    it('are written whole and within their bounds, for the caller org only', async () => {
        const { service, settings } = setup();
        const next = { enabled: false, forks: 'members', idleMinutes: 30, ceilingMinutes: 60, monthlyMachineMinutes: 600 } as const;
        await expect(service.update({ user: owner, body: next })).resolves.toMatchObject({ settings: next });
        for (const bad of [{ ...next, idleMinutes: 2 }, { ...next, ceilingMinutes: 240 }, { ...next, forks: 'anyone' }, { enabled: true }, { ...next, extra: 1 }]) {
            await expect(service.update({ user: owner, body: bad })).rejects.toBeInstanceOf(BadRequestException);
        }
        expect(settings.rows.get(OTHER_ORG)).toBeUndefined();
        expect((await service.get({ user: other })).settings).toEqual(DEFAULT_PREVIEW_SETTINGS);
    });

    it('a stored field that is no longer valid reads as its default, the others as stored', () => {
        expect(previewSettingsOf({ enabled: false, idleMinutes: 999, forks: 'members' })).toEqual({ ...DEFAULT_PREVIEW_SETTINGS, enabled: false, forks: 'members' });
    });
});

describe('preview activity on the owner audit', () => {
    const row = (org: string, previewId: string): PreviewAuditRecord => ({ at: NOW.toISOString(), organizationId: org, previewId, action: 'session_opened', actor: 'user-1' });

    it("lists the org's preview rows, of one preview when asked, and refuses a malformed preview id", async () => {
        const mine = previewIdFor(ORG, 'run-1', 'pr');
        const asked: Array<Parameters<RuntimePreviewAuditReader['list']>[0]> = [];
        const reader: RuntimePreviewAuditReader = {
            // A bad adapter that leaks another org's row is still filtered.
            list: async (input) => (asked.push(input), [row(ORG, mine), row(OTHER_ORG, mine)]),
            sessionsOfMonth: async () => 0,
        };
        const audit = new ListRuntimeAuditUseCase({ list: async () => [] }, reader);
        expect((await audit.execute({ user: owner, kind: 'preview', previewId: mine })).items).toEqual([row(ORG, mine)]);
        expect(asked[0]).toEqual({ organizationId: ORG, limit: 50, previewId: mine });
        await expect(audit.execute({ user: owner, kind: 'preview', previewId: '../x' })).rejects.toBeInstanceOf(BadRequestException);
    });
});
