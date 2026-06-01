import {
    getBYOK,
    getLLMConfigStatus,
} from "@services/organizationParameters/fetch";

import { ByokManualPageClient } from "./page.client";

export default async function ByokManualPage({
    searchParams,
}: {
    searchParams: Promise<{ slot?: "main" | "fallback" }>;
}) {
    const { slot: slotParam } = await searchParams;
    const slot = slotParam === "fallback" ? "fallback" : "main";

    const [byokConfig, llmConfigStatus] = await Promise.all([
        getBYOK().catch(() => null),
        getLLMConfigStatus().catch(() => null),
    ]);

    const existingConfig =
        slot === "main"
            ? (byokConfig?.main ?? null)
            : (byokConfig?.fallback ?? null);

    return (
        <ByokManualPageClient
            slot={slot}
            existingConfig={existingConfig}
            llmConfigStatus={llmConfigStatus}
        />
    );
}
