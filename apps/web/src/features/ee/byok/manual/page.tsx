import { getLLMConfigStatus } from "@services/organizationParameters/fetch";

import { ByokManualPageClient } from "./page.client";

export default async function ByokManualPage({
    searchParams,
}: {
    searchParams: Promise<{ slot?: "main" | "fallback" }>;
}) {
    const { slot: slotParam } = await searchParams;
    const slot = slotParam === "fallback" ? "fallback" : "main";

    const llmConfigStatus = await getLLMConfigStatus().catch(() => null);

    // The persisted blob is now the v2 shape ({credentials, models, routing}),
    // which carries no legacy main/fallback slot — post-04b `byokConfig.main`
    // was already undefined at runtime, so there is nothing to pre-fill here.
    // The v2 manual edit pre-fill is rewired in 04-08.
    const existingConfig = null;

    return (
        <ByokManualPageClient
            slot={slot}
            existingConfig={existingConfig}
            llmConfigStatus={llmConfigStatus}
        />
    );
}
