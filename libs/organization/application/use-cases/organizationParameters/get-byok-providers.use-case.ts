import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
// Barrel import (side-effect self-registers every provider module) so
// REGISTRY.all() enumerates the full BYOKProvider set. This is the single
// source of truth for the connectable-provider LIST the web picker renders.
import { REGISTRY } from '@libs/llm/providers';
import { describeProviderId } from '@libs/llm/providers/provider-ui-descriptor';
import { Injectable } from '@nestjs/common';

/**
 * One connectable provider descriptor — STATIC and NON-SENSITIVE (no org data,
 * no secret, no credential). Mirrors the registry `ProviderModule`'s public
 * identity: its canonical `id`, human `label`, and any alias ids that resolve to
 * the same module (e.g. `openai` → [`openai_compatible`]).
 */
export interface ByokProviderDescriptor {
    id: string;
    label: string;
    aliases: string[];
    /** Whether this provider's models can be enumerated (static catalog, or an
     *  HTTP listing with a resolvable base URL) vs. typed by hand. Lets the
     *  picker show an honest subtitle instead of a blanket "Manual setup". */
    autoListModels: boolean;
    /** Provider documentation URL (hardcoded on the module). The web UI falls back
     *  to it when a curated model has no docsUrl. */
    doc?: string;
}

export interface ByokProvidersResult {
    providers: ByokProviderDescriptor[];
}

/**
 * List every registered BYOK provider module. The registry is the single source
 * of truth for which providers are connectable, so providers that have a backend
 * ProviderModule but no curated-models.json entry (amazon_bedrock, google_vertex,
 * novita, anthropic_compatible, moonshot, …) still surface in the web picker.
 *
 * This is a pure, dependency-free descriptor — it reads only the process-wide
 * REGISTRY and never touches org data, secrets, or the database.
 */
@Injectable()
export class GetByokProvidersUseCase implements IUseCase {
    async execute(): Promise<ByokProvidersResult> {
        return {
            providers: REGISTRY.all().map((m) => ({
                id: m.id,
                label: m.label,
                aliases: m.aliases ?? [],
                // Shared derivation (same source the connect form uses), keyed on
                // the canonical id; aliases are custom endpoints (handled web-side).
                autoListModels: describeProviderId(m, m.id).autoListModels,
                // Provider docs URL (hardcoded on the module). The web UI falls
                // back to it when a curated model has no docsUrl.
                doc: m.doc,
            })),
        };
    }
}
