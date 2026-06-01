import {
    getBYOK,
    getLLMConfigStatus,
} from "@services/organizationParameters/fetch";

import { ByokPageClient } from "./_components/page.client";

export default async function ByokPage() {
    const [byokConfig, llmConfigStatus] = await Promise.all([
        getBYOK().catch(() => null),
        getLLMConfigStatus().catch(() => null),
    ]);

    return (
        <ByokPageClient
            config={byokConfig}
            llmConfigStatus={llmConfigStatus}
        />
    );
}
