import {
    getBYOK,
    getLLMConfigStatus,
} from "@services/organizationParameters/fetch";

import { ByokProviderPageClient } from "./page.client";

export default async function ByokProviderPage({
    searchParams,
}: {
    // `credentialId=<BYOKCredential.id>` opens this page in EDIT mode for that
    // connected provider's stored credential (rotate key / update region / base
    // URL). The Providers tab routes every "Edit provider" here.
    searchParams: Promise<{ credentialId?: string }>;
}) {
    const { credentialId } = await searchParams;

    // The full v2 config is needed so the rotate MERGES into it (touch only this
    // credential) rather than overwriting.
    const [existing, llmConfigStatus] = await Promise.all([
        getBYOK().catch(() => null),
        getLLMConfigStatus().catch(() => null),
    ]);

    return (
        <ByokProviderPageClient
            existing={existing}
            credentialId={credentialId}
            llmConfigStatus={llmConfigStatus}
        />
    );
}
