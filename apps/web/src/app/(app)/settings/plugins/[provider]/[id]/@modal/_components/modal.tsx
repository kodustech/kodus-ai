"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MCPPluginsLimitPopover } from "@components/system/mcp-plugins-limit-popover";
import { Avatar, AvatarImage } from "@components/ui/avatar";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Card } from "@components/ui/card";
import { Checkbox } from "@components/ui/checkbox";
import { ConfirmModal } from "@components/ui/confirm-modal";
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { Label } from "@components/ui/label";
import { MagicModalContext } from "@components/ui/magic-modal";
import { PopoverTrigger } from "@components/ui/popover";
import { useToast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { checkIssuesProviderSupported } from "@services/integrations/fetch";
import {
    deleteMCPConnection,
    deleteMCPCustomPlugin,
    initializeOauthCustomMCPPlugin,
    installMCPPlugin,
    updateMCPAllowedTools,
    type getMCPPluginById,
    type getMCPPlugins,
    type getMCPPluginTools,
} from "@services/mcp-manager/fetch";
import {
    CUSTOM_MCP_SESSION_STORAGE_KEYS,
    KODUS_ISSUES_INTEGRATION_ID,
} from "@services/mcp-manager/types";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { EditIcon, PlugIcon, RefreshCwIcon, Trash } from "lucide-react";
import type { AwaitedReturnType } from "src/core/types";
import { revalidateServerSidePath } from "src/core/utils/revalidate-server-side";
import { useSubscriptionStatus } from "src/features/ee/subscription/_hooks/use-subscription-status";

import { AuthMethodConnect } from "./auth-method-connect";
import { RequiredConfiguration } from "./required-configuration";
import { SelectTools } from "./select-tools";

export const PluginModal = ({
    plugin,
    tools,
    installedPlugins,
}: {
    plugin: AwaitedReturnType<typeof getMCPPluginById>;
    tools: AwaitedReturnType<typeof getMCPPluginTools>;
    installedPlugins: AwaitedReturnType<typeof getMCPPlugins>;
}) => {
    const router = useRouter();
    const { toast } = useToast();
    const subscription = useSubscriptionStatus();

    const mcpPluginsLimits = useMemo(() => {
        const total = installedPlugins.length;

        if (!subscription.valid)
            return {
                total,
                canAddMoreRules: false,
                limit: Number.POSITIVE_INFINITY,
            };

        if (
            subscription.status === "free" ||
            subscription.status === "self-hosted"
        )
            return { canAddMoreRules: total < 3, total, limit: 3 };

        if (subscription.status === "licensed-self-hosted")
            return {
                canAddMoreRules: true,
                total,
                limit: Number.POSITIVE_INFINITY,
            };

        return {
            canAddMoreRules: true,
            total,
            limit: Number.POSITIVE_INFINITY,
        };
    }, [subscription, installedPlugins]);

    const isConnected = plugin.isConnected;
    const isDefault = plugin.isDefault;
    const canEdit = usePermission(Action.Update, ResourceType.PluginSettings);
    const canDelete = usePermission(Action.Delete, ResourceType.PluginSettings);
    const { teamId } = useSelectedTeamId();
    // The generic issues MCP reuses the team's code-management integration, so
    // it only works on hosts with a native issue tracker (not Azure Repos or
    // Bitbucket Data Center). Gate install on backend-confirmed support.
    const requiresIssuesSupport = plugin.id === KODUS_ISSUES_INTEGRATION_ID;
    const [isIssuesSupported, setIsIssuesSupported] = useState<boolean | null>(
        requiresIssuesSupport ? null : true,
    );

    const isCustomOauthUnauthorized =
        plugin.authScheme?.toLowerCase() === "oauth2" &&
        ["custom", "kodusmcp"].includes(plugin.provider) &&
        !plugin.active;

    // Only label "OAuth login" when OAuth is the *only* way to connect — not for
    // integrations that also accept a token (e.g. Jira/Linear) or token-only ones.
    const hasNonOauthMethod =
        plugin.authMethods?.some(
            (method) => method.type !== "oauth2" && method.type !== "none",
        ) ?? false;
    const showsOAuthBadge =
        plugin.authScheme?.toLowerCase() === "oauth2" && !hasNonOauthMethod;

    // Managed integrations that require auth (OAuth and/or a token) show the
    // auth-method picker + token form before connecting — covers single-method
    // (e.g. Fireflies: API key only) and multi-method (e.g. Jira: OAuth or token).
    const needsAuthSetup =
        !isConnected &&
        (plugin.authMethods?.some((method) => method.type !== "none") ?? false);

    const [requiredParamsValues, setRequiredParamsValues] = useState<
        Record<string, string>
    >({});

    const [
        confirmInstallationOfToolsWithWarnings,
        setConfirmInstallationOfToolsWithWarnings,
    ] = useState(false);

    const [selectedTools, setSelectedTools] = useState<Array<string>>(
        isConnected
            ? plugin.allowedTools || []
            : tools.filter(({ warning }) => !warning).map(({ slug }) => slug),
    );

    // Para integrações padrão, usar todos os tools disponíveis
    const effectiveSelectedTools = selectedTools;

    const [isResettingAuth, setIsResettingAuth] = useState(false);

    useEffect(() => {
        let mounted = true;

        if (!requiresIssuesSupport || !teamId) {
            return;
        }

        (async () => {
            const result = await checkIssuesProviderSupported({ teamId });

            if (!mounted) {
                return;
            }

            const supported =
                typeof result === "boolean"
                    ? result
                    : "error" in result
                      ? false
                      : Boolean(result);

            setIsIssuesSupported(supported);
        })();

        return () => {
            mounted = false;
        };
    }, [requiresIssuesSupport, teamId]);

    const hasToolsWithWarningSelected = useMemo(
        () =>
            selectedTools.some(
                (tool) => tools.find(({ slug }) => slug === tool)?.warning,
            ),
        [selectedTools, tools],
    );

    const areRequiredParametersValid =
        Object.keys(requiredParamsValues).length ===
            (plugin.requiredParams?.length || 0) &&
        Object.values(requiredParamsValues).every((v) => v.trim().length > 0);

    const [authorizePlugin, { loading: isAuthorizePluginLoading }] =
        useAsyncAction(async (authMethod?: string) => {
            const initializeResponse = await initializeOauthCustomMCPPlugin(
                plugin.provider,
                plugin.id,
                authMethod,
            );
            if (initializeResponse && "authUrl" in initializeResponse) {
                sessionStorage.setItem(
                    CUSTOM_MCP_SESSION_STORAGE_KEYS.INTEGRATION_ID,
                    plugin.id,
                );
                sessionStorage.setItem(
                    CUSTOM_MCP_SESSION_STORAGE_KEYS.INTEGRATION_NAME,
                    plugin.appName,
                );
                sessionStorage.setItem(
                    CUSTOM_MCP_SESSION_STORAGE_KEYS.PROVIDER,
                    plugin.provider,
                );

                return router.push(initializeResponse.authUrl);
            }

            toast({
                variant: "alert",
                title: "Couldn't start authentication",
                description:
                    "Please try again or contact support if the problem persists.",
            });
        });

    const [installPlugin, { loading: isInstallPluginLoading }] = useAsyncAction(
        async () => {
            if (requiresIssuesSupport && isIssuesSupported === false) {
                toast({
                    variant: "warning",
                    title: "Issue tracker not supported",
                    description:
                        "Your connected code provider has no native issue tracker (Azure Repos and Bitbucket Data Center aren't supported).",
                });
                return;
            }

            const installationResponse = await installMCPPlugin({
                id: plugin.id,
                provider: plugin.provider,
                allowedTools: selectedTools,
                authParams: requiredParamsValues,
            });

            const oAuthUrl = installationResponse.metadata.connection.authUrl;

            if (oAuthUrl?.length > 0) {
                window.location.href = oAuthUrl;
                return;
            }

            await revalidateServerSidePath("/settings/plugins");
            router.push("/settings/plugins");
        },
    );

    const [updateTools, { loading: isUpdateToolsLoading }] = useAsyncAction(
        async () => {
            await updateMCPAllowedTools({
                integrationId: plugin.id,
                allowedTools: selectedTools,
            });

            await revalidateServerSidePath("/settings/plugins");

            toast({
                variant: "success",
                title: "Tools updated successfully",
                description: `Updated ${selectedTools.length} tools for ${plugin.appName}`,
            });

            router.back();
        },
    );

    const [resetAuth, { loading: isResetAuthLoading }] = useAsyncAction(
        async () => {
            if (!plugin.connectionId) {
                throw new Error("Connection ID not found");
            }

            await deleteMCPConnection({
                connectionId: plugin.connectionId,
            });

            await revalidateServerSidePath("/settings/plugins");

            toast({
                variant: "success",
                title: "Authentication reset successfully",
                description: `${plugin.appName} plugin has been disconnected`,
            });

            setIsResettingAuth(false);
            router.back();
        },
    );

    const [deletePlugin, { loading: isDeletePluginLoading }] = useAsyncAction(
        async () => {
            if (!plugin.id) {
                throw new Error("Plugin ID not found");
            }

            if (plugin.provider !== "custom") {
                throw new Error("Only custom plugins can be deleted");
            }

            if (isConnected && plugin.connectionId) {
                await deleteMCPConnection({
                    connectionId: plugin.connectionId,
                });
            }

            await deleteMCPCustomPlugin(plugin.id);

            await revalidateServerSidePath("/settings/plugins");

            toast({
                variant: "success",
                title: "Plugin deleted successfully",
                description: `${plugin.appName} plugin has been deleted`,
            });

            router.push("/settings/plugins");
        },
    );

    const isAnyLoading =
        isInstallPluginLoading ||
        isUpdateToolsLoading ||
        isResetAuthLoading ||
        isDeletePluginLoading;

    const isIssuesProviderUnsupported =
        requiresIssuesSupport && isIssuesSupported === false;
    const isIssuesSupportPending =
        requiresIssuesSupport && isIssuesSupported === null;
    const isIssuesSupportBlocked =
        isIssuesProviderUnsupported || isIssuesSupportPending;

    return (
        <MagicModalContext
            value={{
                closeable: !isInstallPluginLoading && !isUpdateToolsLoading,
            }}>
            <Dialog open onOpenChange={() => router.push("/settings/plugins")}>
                <DialogContent className="max-w-4xl">
                    <DialogHeader className="flex-row items-start justify-start gap-4">
                        <Avatar className="bg-card-lv3 size-16 rounded-lg p-1">
                            <AvatarImage src={plugin.logo} />
                        </Avatar>

                        <div className="flex min-h-16 flex-col justify-center gap-1">
                            <DialogTitle className="capitalize">
                                {plugin.appName}
                            </DialogTitle>

                            <div className="flex items-center gap-2">
                                {plugin.description && (
                                    <span className="text-text-secondary text-sm leading-tight">
                                        {plugin.description}
                                    </span>
                                )}
                            </div>
                        </div>
                    </DialogHeader>

                    <div className="-mx-6 overflow-auto px-6">
                        <div className="flex flex-col gap-3">
                            {(showsOAuthBadge || isConnected || isDefault) && (
                                <div className="mb-2 flex items-center gap-2">
                                    {showsOAuthBadge && (
                                        <Badge className="pointer-events-none">
                                            Oauth login
                                        </Badge>
                                    )}

                                    {isConnected && (
                                        <Badge
                                            variant="tertiary"
                                            className="bg-success! text-card-lv2!">
                                            Installed
                                        </Badge>
                                    )}

                                    {isDefault && (
                                        <Badge
                                            variant="secondary"
                                            className="bg-primary! text-primary-foreground!">
                                            Default
                                        </Badge>
                                    )}
                                </div>
                            )}

                            {(plugin.requiredParams?.length || 0) > 0 && (
                                <RequiredConfiguration
                                    plugin={plugin}
                                    values={requiredParamsValues}
                                    setValuesAction={setRequiredParamsValues}
                                    isValid={areRequiredParametersValid}
                                />
                            )}

                            {isIssuesSupportBlocked && (
                                <Card
                                    className="flex w-full flex-col gap-2 px-4 py-3 text-sm"
                                    color="lv1">
                                    {isIssuesSupportPending ? (
                                        <p className="text-text-secondary">
                                            Checking issue-tracker support…
                                        </p>
                                    ) : (
                                        <p className="text-text-secondary">
                                            Your connected code provider doesn’t
                                            have a native issue tracker (Azure
                                            Repos and Bitbucket Data Center
                                            aren’t supported), so this MCP can’t
                                            be installed.
                                        </p>
                                    )}
                                </Card>
                            )}

                            {needsAuthSetup && plugin.authMethods ? (
                                <AuthMethodConnect
                                    integrationId={plugin.id}
                                    appName={plugin.appName}
                                    authMethods={plugin.authMethods}
                                    canEdit={canEdit}
                                    isDefault={Boolean(isDefault)}
                                    onAuthorize={(authMethod) =>
                                        authorizePlugin(authMethod)
                                    }
                                    isAuthorizing={isAuthorizePluginLoading}
                                />
                            ) : isCustomOauthUnauthorized && !isConnected ? (
                                <Card
                                    className="flex w-full flex-col items-center justify-center py-8"
                                    color="lv1">
                                    <p className="mb-4 text-center text-sm text-gray-500">
                                        This plugin requires OAuth
                                        authentication. Please authenticate to
                                        continue.
                                    </p>
                                    <Button
                                        size="md"
                                        variant="primary"
                                        leftIcon={<PlugIcon />}
                                        onClick={() => {
                                            authorizePlugin();
                                        }}
                                        loading={isAuthorizePluginLoading}
                                        disabled={!canEdit || isDefault}>
                                        Authenticate with {plugin.appName}
                                    </Button>
                                </Card>
                            ) : (
                                <SelectTools
                                    tools={tools.length > 0 ? tools : []}
                                    defaultOpen={
                                        (plugin.requiredParams?.length || 0) ===
                                        0
                                    }
                                    selectedTools={effectiveSelectedTools}
                                    setSelectedToolsAction={(tools) => {
                                        setSelectedTools(tools);
                                        setConfirmInstallationOfToolsWithWarnings(
                                            false,
                                        );
                                    }}
                                />
                            )}
                        </div>
                    </div>

                    <DialogFooter className="mt-0 items-center justify-between">
                        <>
                            <div>
                                {hasToolsWithWarningSelected && (
                                    <Label className="flex items-center gap-4 select-none">
                                        <Checkbox
                                            variant="tertiary"
                                            checked={
                                                confirmInstallationOfToolsWithWarnings
                                            }
                                            onCheckedChange={(c) => {
                                                if (c === "indeterminate")
                                                    return;

                                                setConfirmInstallationOfToolsWithWarnings(
                                                    c,
                                                );
                                            }}
                                        />

                                        <span className="text-danger max-w-80 leading-tight">
                                            I understand there are dangerous
                                            tools selected and I confirm the
                                            installation of these tools
                                        </span>
                                    </Label>
                                )}
                            </div>

                            <div className="flex flex-row gap-x-2">
                                <DialogClose disabled={isAnyLoading}>
                                    <Button size="md" variant="cancel">
                                        {isConnected ? "Close" : "Go back"}
                                    </Button>
                                </DialogClose>

                                {plugin.provider === "custom" && (
                                    <Button
                                        size="md"
                                        variant="secondary"
                                        leftIcon={<EditIcon />}
                                        onClick={() =>
                                            router.push(
                                                `/settings/plugins/custom?edit=true&id=${plugin.id}`,
                                            )
                                        }
                                        disabled={isAnyLoading || !canEdit}>
                                        Edit Plugin
                                    </Button>
                                )}

                                {plugin.provider === "custom" && (
                                    <Button
                                        size="md"
                                        variant="tertiary"
                                        leftIcon={<Trash />}
                                        onClick={() => deletePlugin()}
                                        disabled={
                                            isAnyLoading ||
                                            isDefault ||
                                            !canDelete
                                        }>
                                        Delete Plugin
                                    </Button>
                                )}

                                {!isConnected ? (
                                    <>
                                        {mcpPluginsLimits.canAddMoreRules ? (
                                            <Button
                                                size="md"
                                                variant="primary"
                                                leftIcon={<PlugIcon />}
                                                loading={isInstallPluginLoading}
                                                onClick={() => installPlugin()}
                                                disabled={
                                                    !canEdit ||
                                                    isDefault ||
                                                    !areRequiredParametersValid ||
                                                    selectedTools.length ===
                                                        0 ||
                                                    isIssuesSupportBlocked ||
                                                    (hasToolsWithWarningSelected &&
                                                        !confirmInstallationOfToolsWithWarnings)
                                                }>
                                                Install plugin
                                            </Button>
                                        ) : (
                                            <MCPPluginsLimitPopover
                                                limit={mcpPluginsLimits.limit}>
                                                <PopoverTrigger asChild>
                                                    <Button
                                                        size="md"
                                                        variant="primary"
                                                        leftIcon={<PlugIcon />}
                                                        disabled={
                                                            !canEdit ||
                                                            isDefault ||
                                                            !areRequiredParametersValid ||
                                                            selectedTools.length ===
                                                                0 ||
                                                            isIssuesSupportBlocked ||
                                                            (hasToolsWithWarningSelected &&
                                                                !confirmInstallationOfToolsWithWarnings)
                                                        }>
                                                        Install plugin
                                                    </Button>
                                                </PopoverTrigger>
                                            </MCPPluginsLimitPopover>
                                        )}
                                    </>
                                ) : (
                                    <>
                                        {isDefault ? null : (
                                            <Button
                                                size="md"
                                                variant="tertiary"
                                                leftIcon={<RefreshCwIcon />}
                                                onClick={() =>
                                                    setIsResettingAuth(true)
                                                }
                                                disabled={
                                                    !canEdit ||
                                                    isDefault ||
                                                    isResetAuthLoading
                                                }>
                                                Reset Authentication
                                            </Button>
                                        )}
                                        <Button
                                            size="md"
                                            variant="primary"
                                            leftIcon={<EditIcon />}
                                            loading={isUpdateToolsLoading}
                                            onClick={() => updateTools()}
                                            disabled={
                                                !canEdit ||
                                                selectedTools.length === 0 ||
                                                (hasToolsWithWarningSelected &&
                                                    !confirmInstallationOfToolsWithWarnings)
                                            }>
                                            Update Tools
                                        </Button>
                                    </>
                                )}
                            </div>
                        </>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <ConfirmModal
                open={isResettingAuth}
                title="Reset Plugin Authentication"
                description="This will disconnect the plugin and remove all authentication data. You'll need to reinstall and reconfigure the plugin."
                confirmText="Reset Authentication"
                variant="tertiary"
                loading={isResetAuthLoading}
                onConfirm={() => resetAuth()}
                onCancel={() => setIsResettingAuth(false)}
            />
        </MagicModalContext>
    );
};
