"use client";

import { useEffect, useState } from "react";
import { Button } from "@components/ui/button";
import { Card, CardHeader } from "@components/ui/card";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@components/ui/collapsible";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { KodyReviewPreview } from "@components/ui/kody-review-preview";
import { magicModal } from "@components/ui/magic-modal";
import { Switch } from "@components/ui/switch";
import { createCodeManagementIntegration } from "@services/codeManagement/fetch";
import { AxiosError } from "axios";
import { SaveIcon } from "lucide-react";
import { GitTokenDocs } from "src/core/components/system/git-token-docs";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "src/core/components/ui/dialog";
import { AuthMode, PlatformType } from "src/core/types";

import {
    getGithubTokenConfig,
    getGithubTokenErrorMessage,
    isValidGithubEnterpriseUrl,
    resolveGithubTokenHost,
} from "./github-token-config";

function getUsernameFromEmail(email: string): string {
    return email.split("@")[0] || email;
}

export const GithubTokenModal = (props: {
    teamId: string;
    userId: string;
    userEmail: string;
    githubEnterpriseServerPatEnabled: boolean;
}) => {
    const [token, setToken] = useState("");
    const [selfhosted, setSelfhosted] = useState(false);
    const [selfHostedUrl, setSelfHostedUrl] = useState("");
    const [error, setError] = useState({ message: "" });
    const [selfHostedUrlError, setSelfHostedUrlError] = useState("");
    const githubTokenConfig = getGithubTokenConfig({
        githubEnterpriseServerPatEnabled:
            props.githubEnterpriseServerPatEnabled,
    });

    useEffect(() => {
        if (error.message || selfHostedUrlError) {
            setError({ message: "" });
            setSelfHostedUrlError("");
        }
    }, [token, selfHostedUrl]);

    const submit = async () => {
        if (
            selfhosted &&
            selfHostedUrl &&
            !isValidGithubEnterpriseUrl(selfHostedUrl)
        ) {
            setSelfHostedUrlError("Enter a valid URL");
            return;
        }

        magicModal.lock();

        try {
            await createCodeManagementIntegration({
                integrationType: PlatformType.GITHUB,
                authMode: AuthMode.TOKEN,
                token,
                host: resolveGithubTokenHost({
                    githubEnterpriseServerPatEnabled:
                        props.githubEnterpriseServerPatEnabled,
                    selfHosted: selfhosted,
                    selfHostedUrl,
                }),
                organizationAndTeamData: {
                    teamId: props.teamId,
                },
            });

            magicModal.hide(true);
        } catch (error) {
            magicModal.unlock();

            if (error instanceof AxiosError && error.status === 400) {
                setError({
                    message: getGithubTokenErrorMessage({
                        selfHosted: selfhosted,
                    }),
                });
            }
        }
    };

    const [formIsSubmitting, setFormIsSubmitting] = useState(false);
    const canSubmit =
        !!token &&
        !error.message &&
        !selfHostedUrlError &&
        (!githubTokenConfig.showSelfHosted ||
            !selfhosted ||
            (!!selfHostedUrl.trim() &&
                isValidGithubEnterpriseUrl(selfHostedUrl.trim())));

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent>
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (!canSubmit || formIsSubmitting) return;

                        setFormIsSubmitting(true);
                        void submit().finally(() => {
                            setFormIsSubmitting(false);
                        });
                    }}>
                    <DialogHeader>
                        <DialogTitle>Github Personal Access Token</DialogTitle>
                        <DialogDescription></DialogDescription>
                    </DialogHeader>

                    <div className="border-informative/20 bg-informative/5 my-4 flex flex-col gap-3 rounded-xl border p-4">
                        <p className="text-text-secondary text-sm">
                            Reviews will be posted from the token owner's
                            account:
                        </p>
                        <KodyReviewPreview
                            mode="inline"
                            author={{
                                name: getUsernameFromEmail(props.userEmail),
                            }}
                            comment="Consider adding error handling here to prevent unhandled promise rejections."
                            codeLine={{
                                number: 42,
                                content: "const result = await fetchData();",
                            }}
                        />
                        <p className="text-destructive text-sm font-semibold">
                            GitHub Checks/PR status won&apos;t be available with
                            PAT tokens.
                        </p>
                    </div>

                    <div className="flex flex-col gap-4">
                        <FormControl.Root>
                            <FormControl.Input>
                                <Input
                                    type="password"
                                    value={token}
                                    error={error.message}
                                    onChange={(event) =>
                                        setToken(event.target.value)
                                    }
                                    placeholder="Paste your Token here"
                                />
                            </FormControl.Input>

                            <FormControl.Error>
                                {error.message}
                            </FormControl.Error>
                        </FormControl.Root>

                        {githubTokenConfig.showSelfHosted && (
                            <Collapsible
                                open={selfhosted}
                                onOpenChange={(open) => setSelfhosted(open)}
                                className="flex flex-col gap-1">
                                <div className="relative">
                                    <CollapsibleTrigger asChild>
                                        <Button
                                            type="button"
                                            variant="helper"
                                            size="lg"
                                            className="w-full items-center justify-between py-4">
                                            <FormControl.Label className="mb-0">
                                                Self-hosted
                                            </FormControl.Label>
                                        </Button>
                                    </CollapsibleTrigger>

                                    <div className="pointer-events-none absolute inset-y-0 right-6 flex items-center">
                                        <Switch
                                            decorative
                                            checked={selfhosted}
                                        />
                                    </div>
                                </div>

                                <CollapsibleContent>
                                    <Card color="lv1">
                                        <CardHeader>
                                            <FormControl.Root>
                                                <FormControl.Label htmlFor="github-selfhost-url">
                                                    GitHub Enterprise URL
                                                </FormControl.Label>

                                                <FormControl.Input>
                                                    <Input
                                                        id="github-selfhost-url"
                                                        value={selfHostedUrl}
                                                        error={
                                                            selfHostedUrlError
                                                        }
                                                        onChange={(event) =>
                                                            setSelfHostedUrl(
                                                                event.target
                                                                    .value,
                                                            )
                                                        }
                                                        placeholder="https://github.your-company.com"
                                                    />
                                                </FormControl.Input>

                                                <FormControl.Error>
                                                    {selfHostedUrlError}
                                                </FormControl.Error>
                                            </FormControl.Root>
                                        </CardHeader>
                                    </Card>
                                </CollapsibleContent>
                            </Collapsible>
                        )}

                        <GitTokenDocs provider="github" />
                    </div>

                    <DialogFooter>
                        <Button
                            size="md"
                            type="button"
                            variant="cancel"
                            onClick={() => magicModal.hide()}>
                            Cancel
                        </Button>

                        <Button
                            size="md"
                            type="submit"
                            variant="primary"
                            leftIcon={<SaveIcon />}
                            loading={formIsSubmitting}
                            disabled={!canSubmit}>
                            Validate and save
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};
