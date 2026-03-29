"use client";

import { useEffect, useState, type FormEvent } from "react";
import { GitTokenDocs } from "@components/system/git-token-docs";
import { Alert, AlertDescription, AlertTitle } from "@components/ui/alert";
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
import { Switch } from "@components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@components/ui/tabs";
import { useAsyncAction } from "@hooks/use-async-action";
import { AxiosError } from "axios";
import { Info, Save } from "lucide-react";

type Props = {
    onGoToOauth: () => void;
    onSaveToken: (token: string, selfHostedUrl?: string) => Promise<void>;
    githubEnterpriseServerPatEnabled: boolean;
};

export const GithubModal = (props: Props) => {
    const [token, setToken] = useState("");
    const [selfhosted, setSelfhosted] = useState(false);
    const [selfHostedUrl, setSelfHostedUrl] = useState("");
    const [error, setError] = useState({ message: "" });

    useEffect(() => {
        setError({ message: "" });
    }, [token]);

    const canSubmit =
        !!token &&
        !error.message &&
        (!props.githubEnterpriseServerPatEnabled ||
            !selfhosted ||
            !!selfHostedUrl);

    const [saveToken, { loading: loadingSaveToken }] = useAsyncAction(
        async () => {
            magicModal.lock();

            try {
                await props.onSaveToken(
                    token,
                    props.githubEnterpriseServerPatEnabled && selfhosted
                        ? selfHostedUrl
                        : undefined,
                );
                magicModal.hide();
            } catch (error) {
                magicModal.unlock();

                if (error instanceof AxiosError && error.status === 400) {
                    setError({ message: "Invalid Token" });
                }
            }
        },
    );

    const handleTokenSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!canSubmit) return;

        void saveToken();
    };

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        <span className="capitalize">Github</span> - New
                        Integration
                    </DialogTitle>
                </DialogHeader>

                <Tabs defaultValue="oauth">
                    <TabsList>
                        <TabsTrigger value="oauth">OAuth</TabsTrigger>
                        <TabsTrigger value="token">Token</TabsTrigger>
                    </TabsList>

                    <TabsContent value="oauth">
                        <Alert variant="info" className="mb-4">
                            <Info />
                            <AlertTitle>Recommended</AlertTitle>
                            <AlertDescription>
                                OAuth provides full integration, including
                                automatic PR checks and status updates.
                            </AlertDescription>
                        </Alert>
                        <DialogFooter>
                            <Button
                                size="md"
                                variant="primary"
                                onClick={props.onGoToOauth}>
                                Go to OAuth
                            </Button>
                        </DialogFooter>
                    </TabsContent>

                    <TabsContent value="token">
                        <form
                            className="flex flex-col gap-4"
                            onSubmit={handleTokenSubmit}>
                            <Alert variant="info" className="mb-4">
                                <Info />
                                <AlertTitle>Heads up!</AlertTitle>
                                <AlertDescription>
                                    <div className="flex flex-col gap-1">
                                        <span>
                                            Unlike OAuth, reviews will be
                                            published using your profile - not
                                            Kody's.
                                        </span>
                                        <span className="text-destructive font-semibold">
                                            GitHub Checks/PR status won't be
                                            available with PAT tokens.
                                        </span>
                                    </div>
                                </AlertDescription>
                            </Alert>

                            <FormControl.Root>
                                <FormControl.Input>
                                    <Input
                                        type="password"
                                        value={token}
                                        error={error.message}
                                        onChange={(e) =>
                                            setToken(e.target.value)
                                        }
                                        placeholder="Personal Access Token"
                                    />

                                    <FormControl.Error>
                                        {error.message}
                                    </FormControl.Error>
                                </FormControl.Input>
                            </FormControl.Root>

                            {props.githubEnterpriseServerPatEnabled && (
                                <Collapsible
                                    open={selfhosted}
                                    onOpenChange={(s) => setSelfhosted(s)}
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
                                                            value={
                                                                selfHostedUrl
                                                            }
                                                            onChange={(e) =>
                                                                setSelfHostedUrl(
                                                                    e.target
                                                                        .value,
                                                                )
                                                            }
                                                            placeholder="https://github.your-company.com"
                                                        />
                                                    </FormControl.Input>
                                                </FormControl.Root>
                                            </CardHeader>
                                        </Card>
                                    </CollapsibleContent>
                                </Collapsible>
                            )}

                            <GitTokenDocs provider="github" />

                            <DialogFooter>
                                <Button
                                    size="md"
                                    type="submit"
                                    variant="primary"
                                    leftIcon={<Save />}
                                    loading={loadingSaveToken}
                                    disabled={!canSubmit}>
                                    Validate and save
                                </Button>
                            </DialogFooter>
                        </form>
                    </TabsContent>
                </Tabs>
            </DialogContent>
        </Dialog>
    );
};
