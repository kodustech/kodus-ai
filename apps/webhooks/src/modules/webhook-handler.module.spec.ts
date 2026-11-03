import { MODULE_METADATA } from '@nestjs/common/constants';

import { WebhookHandlerModule } from './webhook-handler.module';

// The real SharedConfigModule validates the env (API_PORT, …) at import time,
// which CI does not provide. This spec only reads the declared imports.
jest.mock('@libs/shared/infrastructure/shared-config.module', () => ({
    SharedConfigModule: class SharedConfigModule {},
}));

/**
 * `webhooks` is the ingestion path: receive, verify, enqueue. Anything in the
 * root `imports` is instantiated at boot in every task, so pulling a domain
 * graph in here doubles the baseline memory (#2007: Kody Rules + Mongo took it
 * from ~240 MB to ~470 MB and OOM-killed both tasks ~8×/day).
 */
describe('WebhookHandlerModule boot graph', () => {
    const imports: unknown[] =
        Reflect.getMetadata(MODULE_METADATA.IMPORTS, WebhookHandlerModule) ??
        [];

    // Compared by class name: importing KodyRulesModule / SharedMongoModule
    // here just to compare identity would load the very graph this guards
    // against and made the suite take ~5s.
    const importedNames = imports.map(
        (entry: any) => (entry?.module ?? entry)?.name,
    );

    it('does not boot the Kody Rules graph', () => {
        expect(importedNames).not.toContain('KodyRulesModule');
    });

    it('does not open a Mongo connection', () => {
        expect(importedNames).not.toContain('SharedMongoModule');
    });
});
