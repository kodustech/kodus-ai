import { useEffect, useState } from "react";
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
import type { INTEGRATIONS_KEY } from "@enums";
import { useAsyncAction } from "@hooks/use-async-action";
import { AxiosError } from "axios";
import { Info } from "lucide-react";

type Props = {
    integration: INTEGRATIONS_KEY;
    onGoToOauth: () => Promise<void>;
    onSaveToken: (token: string, selfHostedUrl?: string) => Promise<void>;
    showSelfHosted?: boolean;
};

export const OauthOrTokenModal = (props: Props) => {
    const [token, setToken] = useState("");
    const [error, setError] = useState({ message: "" });
    const [selfhosted, setSelfhosted] = useState(false);
    const [selfHostedUrl, setSelfHostedUrl] = useState("");

    useEffect(() => {
        setError({ message: "" });
    }, [token]);

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

                if (error instanceof AxiosError && error.status === 400) {
                    setError({ message: "Invalid Token" });
                }
            }
        },
    );

    const [goToOAuth, { loading: loadingGoToOauth }] = useAsyncAction(
        props.onGoToOauth,
    );

    const selfHostedLabel =
        props.integration === "github" ? "GitHub Enterprise URL" : "Gitlab URL";

    const selfHostedPlaceholder =
        props.integration === "github"
            ? "https://github.your-company.com"
            : "Enter the URL of your authentication server";

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        <span className="capitalize">{props.integration}</span>{" "}
                        - New Integration
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
                                loading={loadingGoToOauth}
                                onClick={goToOAuth}>
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

                        {props.showSelfHosted && (
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

                                        <Switch
                                            decorative
                                            checked={selfhosted}
                                        />
                                    </Button>
                                </CollapsibleTrigger>

                                <CollapsibleContent>
                                    <Card color="lv1">
                                        <CardHeader>
                                            <FormControl.Root>
                                                <FormControl.Label>
                                                    {selfHostedLabel}
                                                </FormControl.Label>

                                                <FormControl.Input>
                                                    <Input
                                                        value={selfHostedUrl}
                                                        onChange={(e) =>
                                                            setSelfHostedUrl(
                                                                e.target.value,
                                                            )
                                                        }
                                                        placeholder={
                                                            selfHostedPlaceholder
                                                        }
                                                    />
                                                </FormControl.Input>
                                            </FormControl.Root>
                                        </CardHeader>
                                    </Card>
                                </CollapsibleContent>
                            </Collapsible>
                        )}

                        <DialogFooter className="mb-6">
                            <Button
                                size="md"
                                variant="primary"
                                onClick={saveToken}
                                loading={loadingSaveToken}
                                disabled={
                                    !token ||
                                    !!error.message ||
                                    (selfhosted && !selfHostedUrl)
                                }>
                                Save Token
                            </Button>
                        </DialogFooter>
                    </TabsContent>
                </Tabs>
            </DialogContent>
        </Dialog>
    );
};
