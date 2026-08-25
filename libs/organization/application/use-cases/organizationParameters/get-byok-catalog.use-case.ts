import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
// Barrel import (side-effect self-registers every provider module) so
// REGISTRY.all() enumerates the full BYOKProvider set. Each module owns its
// curated model list — this is the single source of truth for the web catalog
// that used to live in the frontend `curated-models.json`.
import { REGISTRY } from '@libs/llm/providers';
import {
    resolveCatalogFrom,
    type ResolvedCatalogModel,
} from '@libs/llm/providers/kernel/catalog';
import { Injectable } from '@nestjs/common';

export interface ByokCatalogResult {
    models: ResolvedCatalogModel[];
}

/**
 * The curated model catalog, aggregated from every provider module's `catalog`.
 * Replaces the hand-maintained frontend `curated-models.json`: each brand owns
 * its models on its module, and this flattens them into the identity-stamped
 * shape the web picker renders. Pure + dependency-free — reads only the
 * process-wide REGISTRY, never org data, secrets, or the database.
 */
@Injectable()
export class GetByokCatalogUseCase implements IUseCase {
    async execute(): Promise<ByokCatalogResult> {
        return { models: resolveCatalogFrom(REGISTRY.all()) };
    }
}
