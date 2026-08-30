"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { Page } from "@components/ui/page";
import { toast } from "@components/ui/toaster/use-toast";
import {
    createOrUpdateOrganizationParameter,
    type LLMConfigStatus,
} from "@services/organizationParameters/fetch";
import { OrganizationParametersConfigKey } from "@services/parameters/types";
import { ArrowLeftIcon } from "lucide-react";
import { revalidateServerSidePath } from "src/core/utils/revalidate-server-side";

import { buildByokBlob } from "../_components/byok-write";
import { RotatePanel } from "../_components/rotate-panel";
import { PROVIDER_LABELS } from "../_data/provider-labels";
import type { BYOKConfig } from "../_types";

/**
 * Routed provider-credential editor — the sibling of the routed model editor
 * (`/byok/manual`). Both live on their OWN page so they share the exact same
 * shell: a big `Page.Title` + back arrow + description, with no BYOK tabs above.
 * (Editing a provider used to render inline under the Providers tab, which could
 * never match the model editor's full-page header — hence the split.)
 */
export function ByokProviderPageClient({
    existing,
    credentialId,
}: {
    existing: BYOKConfig | null | undefined;
    credentialId?: string;
    llmConfigStatus?: LLMConfigStatus | null;
}) {
    const router = useRouter();

    const credential = credentialId
        ? existing?.credentials.find((c) => c.id === credentialId && !c.managed)
        : undefined;

    // A probe needs a model to send the test request to; use the first model that
    // authenticates through this credential (a connected provider always has one).
    const probeModelId = credential
        ? existing?.models.find((m) => m.credentialId === credential.id)?.model
        : undefined;

    // Credential gone (deleted in another tab, or a hand-edited URL): don't render
    // a broken form — show the way back instead.
    if (!credential) {
        return (
            <Page.Root>
                <Page.Header className="max-w-full px-6">
                    <Page.TitleContainer>
                        <div className="flex items-center gap-3">
                            <Link href="/byok">
                                <Button
                                    size="icon-xs"
                                    variant="cancel"
                                    aria-label="Back to providers">
                                    <ArrowLeftIcon />
                                </Button>
                            </Link>
                            <Page.Title className="text-balance">
                                Provider not found
                            </Page.Title>
                        </div>
                        <Page.Description className="text-pretty">
                            This provider is no longer connected. Go back to
                            pick another.
                        </Page.Description>
                    </Page.TitleContainer>
                </Page.Header>
            </Page.Root>
        );
    }

    const providerLabel =
        PROVIDER_LABELS[credential.provider] ?? credential.provider;

    const goBack = () => router.push("/byok");

    return (
        <Page.Root>
            <Page.Header className="max-w-full px-6">
                <Page.TitleContainer>
                    <div className="flex items-center gap-3">
                        <Link href="/byok">
                            <Button
                                size="icon-xs"
                                variant="cancel"
                                aria-label="Back to providers">
                                <ArrowLeftIcon />
                            </Button>
                        </Link>
                        <Page.Title className="text-balance">
                            Edit {providerLabel}
                        </Page.Title>
                    </div>
                    <Page.Description className="text-pretty">
                        Update this provider&apos;s stored credentials. Leave
                        the secret fields blank to keep the current ones.
                    </Page.Description>
                </Page.TitleContainer>
            </Page.Header>

            <Page.Content className="max-w-full px-6">
                <RotatePanel
                    credential={credential}
                    probeModelId={probeModelId}
                    onCancel={goBack}
                    onSave={async (apiKey, settings) => {
                        // Merge into the full v2 blob so the rotate only touches
                        // THIS credential's secrets/settings (blank-secret keep
                        // rule), leaving models + routing untouched.
                        const blob = buildByokBlob(existing, {
                            kind: "rotate",
                            credentialId: credential.id,
                            apiKey,
                            settings,
                        });
                        try {
                            await createOrUpdateOrganizationParameter(
                                OrganizationParametersConfigKey.BYOK_CONFIG,
                                blob,
                            );
                            toast({
                                variant: "success",
                                title: "Key updated",
                            });
                            await revalidateServerSidePath("/byok");
                            router.push("/byok");
                        } catch {
                            toast({
                                variant: "danger",
                                title: "Couldn't save",
                                description: "Something went wrong. Try again.",
                            });
                        }
                    }}
                />
            </Page.Content>
        </Page.Root>
    );
}
