"use client";

import { useRef, useState } from "react";
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
    const started = useRef(false);

    const standardPlugin = (status: string, integrationId: string) => {
        if (status !== "success") {
            return setInstallationStatus("error");
        }

        setTimeout(() => {
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

        setTimeout(() => {
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

        // Exactly one finalize per mount, and never cancelled: React runs
        // this effect twice in development and an authorization code redeems
        // only once, while leaving the page right after landing must not
        // abort the install.
        if (started.current) return;
        started.current = true;
        if (status && integrationId) {
            standardPlugin(status, integrationId);
            return;
        }
        if (code && state) {
            customPlugin(code, state);
            return;
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
