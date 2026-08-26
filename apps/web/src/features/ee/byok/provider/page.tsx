import {
    getBYOK,
    getLLMConfigStatus,
    listByokCatalog,
} from "@services/organizationParameters/fetch";

import { CatalogProvider } from "../_data/catalog-context";
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
    // credential) rather than overwriting. The catalog powers the provider-aware
    // credential inputs, mirroring the model editor's data loading.
    const [existing, llmConfigStatus, catalog] = await Promise.all([
        getBYOK().catch(() => null),
        getLLMConfigStatus().catch(() => null),
        listByokCatalog().catch(() => []),
    ]);

    return (
        <CatalogProvider models={catalog}>
            <ByokProviderPageClient
                existing={existing}
                credentialId={credentialId}
                llmConfigStatus={llmConfigStatus}
            />
        </CatalogProvider>
    );
}
