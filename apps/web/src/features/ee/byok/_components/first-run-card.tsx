"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { Image } from "@components/ui/image";
import { toast } from "@components/ui/toaster/use-toast";
import { createOrUpdateOrganizationParameter } from "@services/organizationParameters/fetch";
import { OrganizationParametersConfigKey } from "@services/parameters/types";
import { ExternalLinkIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { revalidateServerSidePath } from "src/core/utils/revalidate-server-side";

import curatedCatalog from "../_data/curated-models.json";
import type { CuratedModel } from "../_data/curated-models.types";
import type { BYOKConnectInput, BYOKConfig } from "../_types";
import {
    buildByokBlob,
    credentialSettingsFromConfig,
    modelFieldsFromConfig,
} from "./byok-write";
import { CuratedCatalog } from "./catalog/catalog";
import { ConnectProviderFlow } from "./connect-provider-flow";

const BYOK_DOCS_URL = "https://docs.kodus.io/how_to_use/en/byok";

/**
 * D-UI-FIRSTRUN empty state. A no-model org sees the 🐶 hero + copy above the
 * shared PROVIDER-FIRST flow (pick a provider → one of its models → paste the
 * key). "Browse all models" still opens the full CuratedCatalog escape hatch.
 * Every write goes through buildByokBlob (blank-key keep rule) → the
 * create-or-update endpoint, with routing.defaultModelId → the new model.
 */
export function FirstRunCard({
    existing,
}: {
    existing: BYOKConfig | null | undefined;
}) {
    const router = useRouter();
    const [showCatalog, setShowCatalog] = useState(false);

    const persist = async (blob: BYOKConfig, modelName: string) => {
        await createOrUpdateOrganizationParameter(
            OrganizationParametersConfigKey.BYOK_CONFIG,
            blob,
        );
        toast({
            variant: "success",
            title: `Connected — ${modelName} is now your default for every task.`,
        });
        await revalidateServerSidePath("/organization/byok");
        router.refresh();
    };

    /** Adapter for the connect path: convert its BYOKConnectInput into a v2 blob. */
    const saveFromCatalog = async (cfg: BYOKConnectInput) => {
        const blob = buildByokBlob(existing, {
            kind: "connect",
            newCredential: {
                provider: cfg.provider,
                apiKey: cfg.apiKey,
                settings: credentialSettingsFromConfig(cfg),
            },
            model: modelFieldsFromConfig(cfg),
        });
        const name =
            (curatedCatalog.models as CuratedModel[]).find(
                (m) => m.id === cfg.model,
            )?.displayName ?? cfg.model;
        await persist(blob, name);
    };

    // Browse-all-models: the full curated catalog (recommended grid + manual).
    if (showCatalog) {
        return (
            <CuratedCatalog
                slot="main"
                existingKeyByProvider={{}}
                onSave={saveFromCatalog}
                onCancel={() => setShowCatalog(false)}
            />
        );
    }

    // The provider-first picker, wrapped with the first-run hero + escape hatches.
    return (
        <ConnectProviderFlow
            existingKeyByProvider={{}}
            onSave={saveFromCatalog}
            hero={
                <>
                    <span aria-hidden className="w-20">
                        <Image
                            src="/assets/images/kody/look-left-with-paws.png"
                            alt="Kody"
                        />
                    </span>

                    <div className="flex max-w-md flex-col gap-2">
                        <h3 className="text-text-primary text-lg font-semibold text-balance">
                            Connect your first provider
                        </h3>
                        <p className="text-text-secondary text-sm text-pretty">
                            Add your key once — then enable as many of that
                            provider’s models as you want. You pay your provider
                            directly, and Kodus never sees your key.
                        </p>
                    </div>
                </>
            }
            footer={
                <>
                    <Button
                        type="button"
                        size="sm"
                        variant="helper"
                        leftIcon={<PlusIcon />}
                        onClick={() => setShowCatalog(true)}>
                        Browse all models
                    </Button>
                    <a
                        href={BYOK_DOCS_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-text-secondary hover:text-text-primary inline-flex items-center gap-1 text-xs hover:underline">
                        How BYOK works
                        <ExternalLinkIcon size={12} />
                    </a>
                </>
            }
        />
    );
}
