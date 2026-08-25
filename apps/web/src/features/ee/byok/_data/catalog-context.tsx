"use client";

import { createContext, useContext, useMemo } from "react";

import type { CuratedModel } from "./curated-models.types";

/**
 * The curated model catalog, fetched from the backend (aggregated from every
 * provider module's `catalog` — the single source of truth that replaced the
 * static `curated-models.json`). The server page fetches it once and hands it to
 * this provider, so every BYOK client component reads the SAME list without its
 * own fetch or a static import.
 */
const CatalogContext = createContext<CuratedModel[]>([]);

export function CatalogProvider({
    models,
    children,
}: {
    models: CuratedModel[];
    children: React.ReactNode;
}) {
    return (
        <CatalogContext.Provider value={models}>
            {children}
        </CatalogContext.Provider>
    );
}

/** Every curated model (backend-sourced). */
export function useCatalog(): CuratedModel[] {
    return useContext(CatalogContext);
}

/** Look up one curated model by its id — the common `.find(m => m.id === id)`. */
export function useCatalogModel(id: string | undefined): CuratedModel | undefined {
    const models = useCatalog();
    return useMemo(
        () => (id ? models.find((m) => m.id === id) : undefined),
        [models, id],
    );
}
