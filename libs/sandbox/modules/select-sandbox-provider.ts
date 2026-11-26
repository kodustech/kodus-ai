import { ConfigService } from '@nestjs/config';

import { E2BSandboxService } from '@libs/sandbox/infrastructure/providers/e2b-sandbox.service';
import { LocalSandboxService } from '@libs/sandbox/infrastructure/providers/local-sandbox.service';
import { NullSandboxProvider } from '@libs/sandbox/infrastructure/providers/null-sandbox.service';
import { RuntimeSandboxService } from '@libs/sandbox/infrastructure/providers/runtime-sandbox.service';
import type { ISandboxEgressPolicy } from '@libs/sandbox/infrastructure/services/sandbox-egress-policy.service';

// Kept out of sandbox.module.ts: that file imports modules (organization parameters, license) whose
// graph leads back to the sandbox module, so a test importing the choice alone hit the cycle.

/**
 * SANDBOX_PROVIDER picks the sandbox (docs/runtime/sandbox.md):
 *   - null, local, e2b, runtime: that provider, as asked;
 *   - auto (the default): e2b when API_E2B_KEY is set (Kodus Cloud today),
 *     else local (commands in the worker's own container, no isolation).
 * auto never picks runtime, even with the Runtime configured: the provider is
 * one per deployment, and the Kody Runtime is released per org (alpha). Auto
 * picking it would move every org's code review onto the Runtime's cells, so a
 * cell outage would break the review of orgs that never had the Runtime.
 * SANDBOX_PROVIDER=runtime opts the whole deployment in.
 */
export function selectSandboxProvider(
    configService: ConfigService,
    egressPolicy?: ISandboxEgressPolicy,
) {
    const provider = configService.get<string>('SANDBOX_PROVIDER') || 'auto';
    if (provider === 'null') return new NullSandboxProvider();
    if (provider === 'local') return new LocalSandboxService(configService);
    if (provider === 'e2b') return new E2BSandboxService(configService, egressPolicy);
    if (provider === 'runtime' || provider === 'runtime-sandbox') return new RuntimeSandboxService(configService);
    if (configService.get<string>('API_E2B_KEY')) return new E2BSandboxService(configService, egressPolicy);
    return new LocalSandboxService(configService);
}

