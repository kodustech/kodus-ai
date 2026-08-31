"use client";

import { useEffect, useState } from "react";
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
import { setIntegrationError } from "src/core/utils/extract-error-message";
import { Info, Save } from "lucide-react";

type Props = {
    onGoToOauth: () => void;
    onSaveToken: (token: string, selfHostedUrl?: string) => Promise<void>;
};

export const GitlabModal = (props: Props) => {
    const [token, setToken] = useState("");
    const [error, setError] = useState({ message: "" });
    const [selfhosted, setSelfhosted] = useState(false);
    const [selfHostedUrl, setSelfHostedUrl] = useState("");

    useEffect(() => {
        setError({ message: "" });
    }, [token]);

    const canSubmit =
        !!token && !error.message && (!selfhosted || !!selfHostedUrl);

    const [saveToken, { loading: loadingSaveToken }] = useAsyncAction(
        async () => {
            magicModal.lock();

            try {
                await props.onSaveToken(
                    token,
                    selfhosted ? selfHostedUrl : undefined,
                );
                magicModal.hide();
            } catch (error) {
                magicModal.unlock();
                setIntegrationError(error, setError);
            }
        },
    );

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        <span>Gitlab</span> - New Integration
                    </DialogTitle>
                </DialogHeader>

                <Tabs defaultValue="oauth">
                    <TabsList>
                        <TabsTrigger value="oauth">OAuth</TabsTrigger>
                        <TabsTrigger value="token">Token</TabsTrigger>
                    </TabsList>

                    <TabsContent value="oauth">
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
                        <Alert variant="info" className="mb-4">
                            <Info />
                            <AlertTitle>Heads up!</AlertTitle>
                            <AlertDescription>
                                Unlike OAuth, reviews will be published using
                                your profile - not Kody's.
                            </AlertDescription>
                        </Alert>

                        <FormControl.Root>
                            <FormControl.Input>
                                <Input
                                    type="password"
                                    value={token}
                                    error={error.message}
                                    onChange={(e) => setToken(e.target.value)}
                                    placeholder="Personal Access Token"
                                />

                                <FormControl.Error>
                                    {error.message}
                                </FormControl.Error>
                            </FormControl.Input>
                        </FormControl.Root>

                        <Collapsible
                            open={selfhosted}
                            onOpenChange={(s) => setSelfhosted(s)}
                            className="mt-4 flex flex-col gap-1">
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
                                                Gitlab URL
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
                                                    placeholder="Enter the URL of your authentication server"
                                                />
                                            </FormControl.Input>
                                        </FormControl.Root>
                                    </CardHeader>
                                </Card>
                            </CollapsibleContent>
                        </Collapsible>

                        <GitTokenDocs provider="gitlab" />

                        <DialogFooter>
                            <Button
                                size="md"
                                onClick={saveToken}
                                variant="primary"
                                loading={loadingSaveToken}
                                leftIcon={<Save />}
                                disabled={!canSubmit}>
                                Validate and save
                            </Button>
                        </DialogFooter>
                    </TabsContent>
                </Tabs>
            </DialogContent>
        </Dialog>
    );
};
