"use client";

import { Page } from "@components/ui/page";
import { toast } from "@components/ui/toaster/use-toast";
import {
    createOrUpdateOrganizationParameter,
    deleteBYOK,
} from "@services/organizationParameters/fetch";
import { OrganizationParametersConfigKey } from "@services/parameters/types";
import { revalidateServerSidePath } from "src/core/utils/revalidate-server-side";

import type { BYOKConfig } from "../_types";
import { BYOKCard } from "./card";

export const ByokPageClient = ({
    config,
}: {
    config: { main: BYOKConfig; fallback: BYOKConfig } | null;
}) => {
    const onSaveMain = async (newConfig: BYOKConfig) => {
        try {
            await createOrUpdateOrganizationParameter(
                OrganizationParametersConfigKey.BYOK_CONFIG,
                {
                    main: newConfig,
                },
            );

            toast({
                variant: "success",
                title: "Main key saved",
            });

            await revalidateServerSidePath("/organization/byok");
        } catch {
            toast({
                variant: "danger",
                title: "Main key couldn't be saved",
            });
        }
    };

    const onSaveFallback = async (newConfig: BYOKConfig) => {
        try {
            await createOrUpdateOrganizationParameter(
                OrganizationParametersConfigKey.BYOK_CONFIG,
                {
                    fallback: newConfig,
                },
            );

            toast({
                variant: "success",
                title: "Fallback key saved",
            });

            await revalidateServerSidePath("/organization/byok");
        } catch {
            toast({
                variant: "danger",
                title: "Fallback key couldn't be saved",
                description:
                    "If you're trying to add Fallback key before Main one, it will not work.",
            });
        }
    };

    const onDeleteMain = async () => {
        try {
            await deleteBYOK({ configType: "main" });

            toast({
                variant: "success",
                title: "Main key deleted",
            });

            await revalidateServerSidePath("/organization/byok");
        } catch {
            toast({
                variant: "danger",
                title: "Main key couldn't be deleted",
            });
        }
    };

    const onDeleteFallback = async () => {
        try {
            await deleteBYOK({ configType: "fallback" });

            toast({
                variant: "success",
                title: "Fallback key deleted",
            });

            await revalidateServerSidePath("/organization/byok");
        } catch {
            toast({
                variant: "danger",
                title: "Fallback key couldn't be deleted",
            });
        }
    };

    return (
        <Page.Root>
            <Page.Header>
                <Page.TitleContainer>
                    <Page.Title>Bring your own key</Page.Title>
                </Page.TitleContainer>
            </Page.Header>

            <Page.Content>
                <div className="flex gap-4">
                    <BYOKCard
                        type="main"
                        config={config?.main}
                        onSave={onSaveMain}
                        onDelete={onDeleteMain}
                        tooltip={
                            <div>
                                <p>This key will be the first to be used.</p>
                            </div>
                        }
                    />
                    <BYOKCard
                        type="fallback"
                        config={config?.fallback}
                        onSave={onSaveFallback}
                        onDelete={onDeleteFallback}
                        tooltip={
                            <p>
                                Optional. This key will be used if Main key
                                fails.
                            </p>
                        }
                    />
                </div>
            </Page.Content>
        </Page.Root>
    );
};
