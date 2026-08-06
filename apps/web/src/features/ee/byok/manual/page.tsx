import {
    getBYOK,
    getLLMConfigStatus,
} from "@services/organizationParameters/fetch";

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
    const [existing, llmConfigStatus] = await Promise.all([
        getBYOK().catch(() => null),
        getLLMConfigStatus().catch(() => null),
    ]);

    return (
        <ByokManualPageClient
            existing={existing}
            editModelId={editModelId}
            presetProvider={presetProvider}
            llmConfigStatus={llmConfigStatus}
        />
    );
}
