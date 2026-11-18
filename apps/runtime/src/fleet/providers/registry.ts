import type { HostProvider } from '@libs/runtime/fleet/host-provider';

// The providers this runtime-fleet holds, by pool provider kind. A kind with
// no provider here makes its pools not scalable (reconcile: provider_not_configured).

export class ProviderRegistry {
    private readonly byKind = new Map<string, HostProvider>();

    constructor(providers: HostProvider[]) {
        for (const p of providers) this.byKind.set(p.kind, p);
    }

    get(kind: string): HostProvider | undefined {
        return this.byKind.get(kind);
    }

    kinds(): string[] {
        return [...this.byKind.keys()];
    }
}
