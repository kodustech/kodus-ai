"use client";

import { useSuspenseGetLLMProviders } from "@services/organizationParameters/hooks";
import { ExternalLinkIcon } from "lucide-react";

/**
 * "Get a key & docs for <provider>" link. The URL is PROVIDER-OWNED (the module's
 * `doc`, surfaced via list-providers) — never hardcoded here — so it points a user
 * at where to grab a key and find model ids. Renders nothing when the provider
 * ships no doc URL. Shared by the key input and the stored-key summary so the
 * link is present in both, from one source.
 */
export const ProviderDocLink = ({ provider }: { provider?: string }) => {
    const { providers } = useSuspenseGetLLMProviders();
    const found = providers.find((p) => p.id === provider);
    if (!found?.doc) return null;

    return (
        <a
            href={found.doc}
            target="_blank"
            rel="noopener noreferrer"
            className="text-text-tertiary hover:text-text-secondary mt-1.5 inline-flex w-fit items-center gap-1 text-xs">
            Get a key & docs for {found.name}
            <ExternalLinkIcon size={11} />
        </a>
    );
};
