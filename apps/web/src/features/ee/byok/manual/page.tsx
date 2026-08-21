import {
    getBYOK,
    getLLMConfigStatus,
    listByokCatalog,
} from "@services/organizationParameters/fetch";

import { CatalogProvider } from "../_data/catalog-context";
import { ByokManualPageClient } from "./page.client";

export default async function ByokManualPage({
    searchParams,
}: {
    // `model=<BYOKModelConfig.id>` opens the manual form in EDIT mode for that
    // connected model (used by the Models tab for non-curated providers, whose
    // models have no CuratedConnectPanel). `provider=<id>` pre-scopes an ADD to
    // that provider (reusing its stored key). Absent ⇒ ADD a fresh model.
    searchParams: Promise<{ model?: string; provider?: string }>;
}) {
    const { model: editModelId, provider: presetProvider } = await searchParams;

    // The full v2 config is needed so a save MERGES into it (add/edit a model
    // in place) rather than overwriting — the whole blob is the intended config.
    // The curated catalog carries each model's connection plans (variants) +
    // endpoint + docs, so the form can surface plan mode / endpoint just like the
    // curated connect panel — provider modules stay the single source of truth.
    const [existing, llmConfigStatus, catalog] = await Promise.all([
        getBYOK().catch(() => null),
        getLLMConfigStatus().catch(() => null),
        listByokCatalog().catch(() => []),
    ]);

    return (
        <CatalogProvider models={catalog}>
            <ByokManualPageClient
                existing={existing}
                editModelId={editModelId}
                presetProvider={presetProvider}
                llmConfigStatus={llmConfigStatus}
            />
        </CatalogProvider>
    );
}
