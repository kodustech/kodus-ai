import type { EnvironmentSetupRecord } from '@libs/runtime/run';
import { boundKeyOfTemplate } from '@libs/runtime/placement/candidate-pools';

import type { BakeProbe, BakeState } from './boat-setup-host';

// How the environment's setup on its template host ended (docs/runtime/host-providers.md §8.2), read from the
// template setup's own record through the setup store, never from the host. Only the setup requested for this setup
// host counts: its command key is the template's bound key and this host's id.

/** The read side of the template setup records (runtime.runtime_template_setups): `PgTemplateSetupStore` fits. */
export interface SetupRecordReader {
    get(setupKey: string, organizationId?: string): Promise<EnvironmentSetupRecord | null>;
}

/** The command key of the setup that builds an environment's template: the bound key and the setup host's id, so it is unique per build. */
export const templateSetupCommandKey = (organizationId: string, environmentId: string, hostId: string) => `${boundKeyOfTemplate(organizationId, environmentId)}:${hostId}`.slice(0, 256);

/**
 * The bake's fingerprint: the digest of every repository's commit and the recipe when the setup has one, else the
 * cell's image id. The setup records them as `sha256:<hex>`; the template name takes bare hex, so the prefix goes, and a
 * value that is not a digest (an image tag such as `latest`) is no fingerprint.
 */
export function bakeFingerprintOf(rec: Pick<EnvironmentSetupRecord, 'bakeRefsDigest' | 'imageId'>): string | null {
    for (const v of [rec.bakeRefsDigest, rec.imageId]) {
        const hex = v?.replace(/^sha256:/, '');
        if (hex && /^[0-9a-f]{16,64}$/.test(hex)) return hex;
    }
    return null;
}

export class SetupRecordBakeProbe implements BakeProbe {
    constructor(private readonly setups: SetupRecordReader) {}

    async read(req: { hostId: string; organizationId: string; environmentId: string }): Promise<BakeState> {
        // Only this host's own setup counts: it is read by its exact key, an earlier attempt's record is another row.
        const rec = await this.setups.get(templateSetupCommandKey(req.organizationId, req.environmentId, req.hostId), req.organizationId);
        if (!rec || rec.organizationId !== req.organizationId) return { state: 'running' };
        if (rec.state === 'setting_up') return { state: 'running' };
        if (rec.state === 'blocked') return { state: 'failed', reason: 'bake_failed' };
        const fingerprint = bakeFingerprintOf(rec);
        if (!fingerprint) return { state: 'failed', reason: 'bake_failed' };
        return { state: 'done', fingerprint, ref: rec.refSource === 'default_branch' ? 'default_branch' : 'other', ...(rec.cellId ? { cellId: rec.cellId } : {}) };
    }
}
