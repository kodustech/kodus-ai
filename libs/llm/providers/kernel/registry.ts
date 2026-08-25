/**
 * Provider registry (Phase 1, plan 01-01).
 *
 * A Map-backed registry keyed by provider id. `registerProvider(module)` records
 * the module under its `id` and every `alias`; `REGISTRY.get(id)` throws a clear
 * per-provider error on an unknown id (never a whole-config crash — that is the
 * one intentional behavior change vs the exhaustive switch, gated in 01-03).
 */
import type { ProviderModule } from './types';

class ProviderRegistry {
    private readonly modules = new Map<string, ProviderModule>();

    /** Register a module under its id + aliases. Double-registration of an id is
     *  a bug (last-wins would silently mask it), so it throws. */
    register(module: ProviderModule): void {
        const ids = [module.id, ...(module.aliases ?? [])];
        for (const id of ids) {
            const existing = this.modules.get(id);
            if (existing && existing !== module) {
                throw new Error(
                    `ProviderRegistry: id "${id}" already registered by "${existing.label}"; ` +
                        `cannot re-register for "${module.label}".`,
                );
            }
            this.modules.set(id, module);
        }
    }

    /** Resolve a module by provider id. Throws a clear per-provider error on an
     *  unknown id. */
    get(id: string): ProviderModule {
        const module = this.modules.get(id);
        if (!module) {
            throw new Error(
                `ProviderRegistry: no provider module registered for id "${id}". ` +
                    `Registered ids: ${this.ids().join(', ') || '(none)'}.`,
            );
        }
        return module;
    }

    has(id: string): boolean {
        return this.modules.has(id);
    }

    /** Every registered id (a module with aliases contributes multiple). */
    ids(): string[] {
        return [...this.modules.keys()];
    }

    /** Distinct modules (a module registered under N ids appears once). Used by
     *  the conformance suite to run the contract per module. */
    all(): ProviderModule[] {
        return [...new Set(this.modules.values())];
    }
}

/** The process-wide provider registry. Modules self-register via side-effect
 *  imports (see libs/llm/providers/index.ts, added in 01-02). */
export const REGISTRY = new ProviderRegistry();

/** Register a provider module (under its id + aliases). */
export function registerProvider(module: ProviderModule): void {
    REGISTRY.register(module);
}
