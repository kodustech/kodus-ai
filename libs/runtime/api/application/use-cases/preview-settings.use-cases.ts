import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { type PreviewSettings, PreviewSettingsSchema } from '@libs/runtime/contracts/preview';

import { RUNTIME_API_CONFIG, RUNTIME_CLOCK, RUNTIME_USAGE_REPORT_READER, type Clock, type RuntimeApiConfig, type RuntimeUsageReportReader } from '../../domain/ports';
import { RUNTIME_PREVIEW_SETTINGS_STORE, type RuntimePreviewSettingsStore } from '../../domain/previews';
import { claimHeldMinutes } from '../../domain/run-cost';
import { currentUsageMonth, USAGE_REPORT_MAX_CLAIMS } from '../../domain/usage-report';

/** The settings page's preview section (docs/runtime/preview-urls.md §8.4). */
export interface RuntimePreviewSettingsView {
    /** The deployment has a preview domain and a grant key (decision 1); false: nothing below takes effect. */
    available: boolean;
    settings: PreviewSettings;
    /** This UTC month's preview machine-minutes, as the cap counts them; null when the Runtime cannot be read here. */
    usedMinutesThisMonth: number | null;
}

const orgOf = (user: Partial<IUser>) => {
    const organizationId = user?.organization?.uuid;
    if (!organizationId) throw new NotFoundException('Organization not found');
    return organizationId;
};

/** GET and PUT /runtime/settings/preview: owner only (the controller's checkRole). */
@Injectable()
export class RuntimePreviewSettingsUseCase {
    constructor(
        @Inject(RUNTIME_PREVIEW_SETTINGS_STORE)
        private readonly store: RuntimePreviewSettingsStore,
        @Inject(RUNTIME_USAGE_REPORT_READER)
        private readonly usage: Pick<RuntimeUsageReportReader, 'claimsOfMonth'>,
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: Pick<RuntimeApiConfig, 'previewDomain' | 'previewGrantPrivateKey'>,
        @Inject(RUNTIME_CLOCK)
        private readonly clock: Clock,
    ) {}

    async get(input: { user: Partial<IUser> }): Promise<RuntimePreviewSettingsView> {
        const organizationId = orgOf(input.user);
        const [settings, usedMinutesThisMonth] = await Promise.all([this.store.getPreviewSettings(organizationId), this.usedThisMonth(organizationId)]);
        return { available: !!this.config.previewDomain && !!this.config.previewGrantPrivateKey, settings, usedMinutesThisMonth };
    }

    /** The whole section at once: every field is required, so a stale page never half-writes it. */
    async update(input: { user: Partial<IUser>; body: unknown }): Promise<RuntimePreviewSettingsView> {
        const organizationId = orgOf(input.user);
        const parsed = PreviewSettingsSchema.safeParse(input.body);
        if (!parsed.success) {
            throw new BadRequestException(
                "Body must be { enabled: boolean, forks: 'off' | 'members', idleMinutes: 5 to 60, ceilingMinutes: 30 to 120, monthlyMachineMinutes: 60 to 1000000 or null }",
            );
        }
        await this.store.setPreviewSettings(organizationId, parsed.data);
        return this.get(input);
    }

    /** The month's preview claims, held minutes each (the worker's cap counts the same). */
    private async usedThisMonth(organizationId: string): Promise<number> {
        const now = this.clock();
        const { claims } = await this.usage.claimsOfMonth(organizationId, currentUsageMonth(now), {}, USAGE_REPORT_MAX_CLAIMS).catch(() => {
            throw new ServiceUnavailableException("This month's preview usage could not be read. Try again.");
        });
        const minutes = claims.filter((c) => c.consumer === 'preview').reduce((sum, c) => sum + (claimHeldMinutes(c, now) ?? 0), 0);
        return Math.round(minutes);
    }
}
