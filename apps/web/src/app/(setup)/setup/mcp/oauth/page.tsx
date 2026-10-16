"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Page } from "@components/ui/page";
import { Spinner } from "@components/ui/spinner";
import { useEffectOnce } from "@hooks/use-effect-once";
import {
    finishOauthCustomMCPPluginInstallation,
    finishOauthMCPPluginInstallation,
} from "@services/mcp-manager/fetch";
import { CUSTOM_MCP_SESSION_STORAGE_KEYS } from "@services/mcp-manager/types";
import { revalidateServerSidePath } from "src/core/utils/revalidate-server-side";

import ErrorComponent from "./_components/error";
import SuccessComponent from "./_components/success";

const componentsMap = {
    success: SuccessComponent,
    error: ErrorComponent,
    loading: () => <Spinner className="size-10" />,
};

export default function MCPOauthPage() {
    const searchParams = useSearchParams();
    const [appName, setAppName] = useState("unknown");

    const integrationId = searchParams.get("integrationId");
    const status = searchParams.get("status");

    const code = searchParams.get("code");
    const state = searchParams.get("state");

    const error = searchParams.get("error");
    if (error) {
        console.error("OAuth Error:", error);
    }

    const [installationStatus, setInstallationStatus] = useState<
        "success" | "error" | "loading"
    >("loading");

    const standardPlugin = (status: string, integrationId: string) => {
        if (status !== "success") {
            return setInstallationStatus("error");
        }

        const timeout = setTimeout(() => {
            finishOauthMCPPluginInstallation({
                id: integrationId,
            })
                .then(async () => {
                    await revalidateServerSidePath("/settings/plugins");
                    setInstallationStatus("success");
                })
                .catch(() => {
                    setInstallationStatus("error");
                });
        }, 1000);

        return () => {
            clearTimeout(timeout);
        };
    };

    const customPlugin = (code: string, state: string) => {
        const integrationId = sessionStorage.getItem(
            CUSTOM_MCP_SESSION_STORAGE_KEYS.INTEGRATION_ID,
        );
        const provider = sessionStorage.getItem(
            CUSTOM_MCP_SESSION_STORAGE_KEYS.PROVIDER,
        );

        if (!integrationId || !provider) {
            console.error(
                "Missing integration ID or provider for custom MCP plugin",
            );
            return setInstallationStatus("error");
        }

        const timeout = setTimeout(() => {
            finishOauthCustomMCPPluginInstallation({
                provider,
                id: integrationId,
                code,
                state,
            })
                .then(async (a) => {
                    await revalidateServerSidePath("/settings/plugins");
                    setInstallationStatus("success");
                })
                .catch((e) => {
                    console.error("Error finishing custom plugin OAuth:", e);
                    setInstallationStatus("error");
                });
        }, 1000);

        return () => {
            clearTimeout(timeout);
        };
    };

    useEffectOnce(() => {
        if (error) {
            console.error("OAuth error received:", error);
            setInstallationStatus("error");
            return;
        }

        if (searchParams.get("appName")) {
            setAppName(searchParams.get("appName") || "unknown");
        } else if (sessionStorage) {
            const storedName = sessionStorage.getItem(
                CUSTOM_MCP_SESSION_STORAGE_KEYS.INTEGRATION_NAME,
            );

            if (storedName) {
                setAppName(storedName);
            }
        }

        // The cleanup cancels the delayed finalize: React runs this effect
        // twice in development, and an authorization code redeems only once,
        // so a second finalize reports a failure for a flow that succeeded.
        if (status && integrationId) {
            return standardPlugin(status, integrationId);
        }
        if (code && state) {
            return customPlugin(code, state);
        }
        setInstallationStatus("error");
    });

    const Component = componentsMap[installationStatus];

    return (
        <Page.Root className="items-center justify-center">
            <Component />

            <span className="text-2xl">
                Installing plugin{" "}
                <div className="inline-block font-bold capitalize">
                    {appName}
                </div>
            </span>
        </Page.Root>
    );
}
