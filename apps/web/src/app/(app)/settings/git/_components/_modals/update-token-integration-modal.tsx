"use client";

import { useEffect, useState } from "react";
import { GitTokenDocs } from "@components/system/git-token-docs";
import { Button } from "@components/ui/button";
import { Card, CardHeader } from "@components/ui/card";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@components/ui/collapsible";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { magicModal } from "@components/ui/magic-modal";
import { toast } from "@components/ui/toaster/use-toast";
import { Switch } from "@components/ui/switch";
import { useAsyncAction } from "@hooks/use-async-action";
import { createCodeManagementIntegration } from "@services/codeManagement/fetch";
import { INTEGRATION_CONFIG } from "@services/integrations/integrationConfig";
import { useReactQueryInvalidateQueries } from "@hooks/use-invalidate-queries";
import { AxiosError } from "axios";
import { Save } from "lucide-react";
import { AuthMode, IntegrationCategory, PlatformType } from "src/core/types";
import { revalidateServerSidePath } from "src/core/utils/revalidate-server-side";

// Token-based providers shown on the connected card. GitHub is excluded: its
// connected flow is OAuth-app driven, so there is no PAT to rotate from here.
const UPDATE_TOKEN_PLATFORMS: Partial<
    Record<Lowercase<PlatformType>, PlatformType>
> = {
    gitlab: PlatformType.GITLAB,
    bitbucket: PlatformType.BITBUCKET,
    azure_repos: PlatformType.AZURE_REPOS,
    forgejo: PlatformType.FORGEJO,
};

type UpdateTokenPlatformKey = keyof typeof UPDATE_TOKEN_PLATFORMS;

// Providers that can point at a self-hosted instance and therefore need an
// optional instance URL alongside the token (GitLab self-hosted, Bitbucket DC,
// Forgejo, GitHub Enterprise share the same host field on the backend).
const SELF_HOSTED_KEYS = new Set(["gitlab", "bitbucket", "forgejo"]);

type Props = {
    /** Existing self-hosted instance URL, when this connection has one. */
    host?: string;
    /** Lowercase integration key, e.g. `gitlab`. */
    platformKey: UpdateTokenPlatformKey;
    platformName: string;
    teamId: string;
};

export const UpdateTokenIntegrationModal = ({
    host,
    platformKey,
    platformName,
    teamId,
}: Props) => {
    const initialHost = host?.trim() ?? "";
    const [token, setToken] = useState("");
    const [error, setError] = useState({ message: "" });
    const [selfhosted, setSelfhosted] = useState(!!initialHost);
    const [selfHostedUrl, setSelfHostedUrl] = useState(initialHost);

    const { invalidateQueries, generateQueryKey } =
        useReactQueryInvalidateQueries();

    useEffect(() => {
        setError({ message: "" });
    }, [token]);

    const integrationType = UPDATE_TOKEN_PLATFORMS[platformKey];

    const canSubmit =
        !!token.trim() &&
        !error.message &&
        (!selfhosted || !!selfHostedUrl.trim());

    const [updateToken, { loading }] = useAsyncAction(async () => {
        if (!integrationType) return;
        magicModal.lock();

        try {
            await createCodeManagementIntegration({
                integrationType,
                authMode: AuthMode.TOKEN,
                token: token.trim(),
                host: selfhosted ? selfHostedUrl.trim() : undefined,
                organizationAndTeamData: {
                    teamId,
                },
            });

            toast({
                variant: "success",
                title: `${platformName} token updated`,
                description: "Applied to the existing integration.",
            });

            await invalidateQueries({
                type: "all",
                queryKey: generateQueryKey(
                    INTEGRATION_CONFIG.GET_INTEGRATION_CONFIG_BY_CATEGORY,
                    {
                        params: {
                            teamId,
                            integrationCategory:
                                IntegrationCategory.CODE_MANAGEMENT,
                        },
                    },
                ),
            });
            await revalidateServerSidePath("/settings/git");

            magicModal.hide();
        } catch (caught) {
            magicModal.unlock();

            if (caught instanceof AxiosError && caught.status === 400) {
                setError({ message: "Invalid Token" });
                return;
            }

            toast({
                variant: "warning",
                title: "Failed to update token",
                description: "Please try again later",
            });
        }
    });

    // Not a token-rotatable provider (e.g. Github OAuth-app) — nothing to show.
    if (!integrationType) {
        return null;
    }

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        <span>{platformName}</span> - Update token
                    </DialogTitle>
                </DialogHeader>

                <p className="text-text-secondary text-sm">
                    Replaces the stored personal access token in place. Webhooks
                    and selected repositories are kept.
                </p>

                <FormControl.Root>
                    <FormControl.Input>
                        <Input
                            type="password"
                            value={token}
                            error={error.message}
                            onChange={(e) => setToken(e.target.value)}
                            placeholder="Personal Access Token"
                        />

                        <FormControl.Error>{error.message}</FormControl.Error>
                    </FormControl.Input>
                </FormControl.Root>

                {SELF_HOSTED_KEYS.has(platformKey) && (
                    <Collapsible
                        open={selfhosted}
                        onOpenChange={(open) => setSelfhosted(open)}
                        className="mt-2 flex flex-col gap-1">
                        <CollapsibleTrigger asChild>
                            <Button
                                type="button"
                                variant="helper"
                                size="lg"
                                className="w-full items-center justify-between py-4">
                                <FormControl.Label className="mb-0">
                                    Self-hosted
                                </FormControl.Label>

                                <Switch decorative checked={selfhosted} />
                            </Button>
                        </CollapsibleTrigger>

                        <CollapsibleContent>
                            <Card color="lv1">
                                <CardHeader>
                                    <FormControl.Root>
                                        <FormControl.Label htmlFor="selfhosted-url">
                                            {platformName} URL
                                        </FormControl.Label>

                                        <FormControl.Input>
                                            <Input
                                                id="selfhosted-url"
                                                value={selfHostedUrl}
                                                onChange={(e) =>
                                                    setSelfHostedUrl(
                                                        e.target.value,
                                                    )
                                                }
                                                placeholder="Enter the URL of your server"
                                            />
                                        </FormControl.Input>
                                    </FormControl.Root>
                                </CardHeader>
                            </Card>
                        </CollapsibleContent>
                    </Collapsible>
                )}

                <GitTokenDocs provider={platformKey} />

                <DialogFooter>
                    <Button
                        size="md"
                        onClick={updateToken}
                        variant="primary"
                        loading={loading}
                        leftIcon={<Save />}
                        disabled={!canSubmit}>
                        Update token
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};