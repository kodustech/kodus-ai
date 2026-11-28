import { Inject, Injectable, Optional } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import { boundKeyOfTemplate } from '@libs/runtime/placement/candidate-pools';

import {
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_RELEASE_GATE,
    RUNTIME_TEMPLATE_SETUP_READER,
    type ProductEnvironmentStore,
    type RuntimeReleaseGate,
    type RuntimeTemplateSetupReader,
} from '../domain/ports';
import { RuntimeSetupRequester } from './runtime-setup-requester.service';

/** The actor of a setup no person asked for: the fleet building an environment template. */
const TEMPLATE_BUILDER = { uuid: 'kodus-template-builder' };

/** How many pending template setups one pass handles. */
const PASS_LIMIT = 50;

/**
 * Issues the `setup_requested` command for the environment template builds the fleet started (docs/runtime/host-providers.md
 * §8.2). The fleet holds no repository or LLM credentials, so it only records the key it chose on the template row; this
 * reads those rows, and asks the one setup request path for the setup under that key, bound to the template host.
 * The worker starts a setup once per command key, so a repeat is harmless; the set below only saves minting tokens again.
 */
@Injectable()
export class RuntimeTemplateSetupRequests {
    private readonly logger = createLogger(RuntimeTemplateSetupRequests.name);
    private readonly issued = new Set<string>();

    constructor(
        @Inject(RUNTIME_TEMPLATE_SETUP_READER) private readonly reader: RuntimeTemplateSetupReader,
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE) private readonly environments: ProductEnvironmentStore,
        private readonly setups: RuntimeSetupRequester,
        @Optional() @Inject(RUNTIME_RELEASE_GATE) private readonly release?: RuntimeReleaseGate,
    ) {}

    /** Never throws: a template that cannot be asked for is logged and left for the next pass. */
    async run(): Promise<{ pending: number; requested: number; skipped: number; failed: number }> {
        let pending;
        try {
            pending = await this.reader.pending(PASS_LIMIT);
        } catch (error) {
            this.logger.error({ message: 'Runtime template setups: pending read failed', context: RuntimeTemplateSetupRequests.name, error: error instanceof Error ? error : undefined });
            return { pending: 0, requested: 0, skipped: 0, failed: 1 };
        }
        let requested = 0;
        let skipped = 0;
        let failed = 0;
        for (const p of pending) {
            if (this.issued.has(p.key)) {
                skipped++;
                continue;
            }
            try {
                const env = await this.environments.get(p.organizationId, p.environmentId);
                if (!env || (this.release && !(await this.release.isEnabledFor(p.organizationId)))) {
                    skipped++;
                    this.logger.warn({ message: 'Runtime template setup skipped: unknown environment or Runtime not released', context: RuntimeTemplateSetupRequests.name, metadata: { organizationId: p.organizationId, environmentId: p.environmentId } });
                    continue;
                }
                await this.setups.request(env, TEMPLATE_BUILDER, { key: p.key, boundKey: boundKeyOfTemplate(p.organizationId, p.environmentId) });
                this.issued.add(p.key);
                requested++;
            } catch (error) {
                failed++;
                this.logger.error({ message: 'Runtime template setup request failed', context: RuntimeTemplateSetupRequests.name, error: error instanceof Error ? error : undefined, metadata: { organizationId: p.organizationId, environmentId: p.environmentId } });
            }
        }
        return { pending: pending.length, requested, skipped, failed };
    }
}
