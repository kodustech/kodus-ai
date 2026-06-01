import { useEffect, useState } from "react";
import { Badge } from "@components/ui/badge";
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
import { useAsyncAction } from "@hooks/use-async-action";
import { AxiosError } from "axios";
import { AuthMode } from "src/core/types";

type Props = {
    onSave: (
        token: string,
        username: string,
        email: string,
        selfHostedUrl?: string,
        authMode?: AuthMode,
    ) => Promise<void>;
};

export const BitbucketModal = (props: Props) => {
    const [username, setUsername] = useState("");
    const [token, setToken] = useState("");
    const [email, setEmail] = useState("");
    const [selfhosted, setSelfhosted] = useState(false);
    const [selfHostedUrl, setSelfHostedUrl] = useState("");
    const [dataCenterPassword, setDataCenterPassword] = useState("");
    const [error, setError] = useState({ message: "" });

    useEffect(() => {
        setError({ message: "" });
    }, [token, username, email, selfHostedUrl, dataCenterPassword]);

    const [saveToken, { loading: loadingSaveToken }] = useAsyncAction(
        async () => {
            magicModal.lock();

            try {
                await props.onSave(
                    selfhosted ? dataCenterPassword : token,
                    username,
                    selfhosted ? "" : email,
                    selfhosted ? selfHostedUrl : undefined,
                    selfhosted ? AuthMode.BASIC : AuthMode.TOKEN,
                );
                magicModal.hide();
            } catch (error) {
                magicModal.unlock();

                if (error instanceof AxiosError && error.status === 400) {
                    setError({ message: "Invalid Token or Username" });
                }
            }
        },
    );

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        <span>Bitbucket</span> - New Integration
                    </DialogTitle>
                </DialogHeader>

                <FormControl.Root>
                    <FormControl.Label htmlFor="bitbucket-username-input">
                        Username
                    </FormControl.Label>

                    <FormControl.Input>
                        <Input
                            type="text"
                            value={username}
                            error={error.message}
                            id="bitbucket-username-input"
                            onChange={(e) => setUsername(e.target.value)}
                            placeholder={
                                selfhosted
                                    ? "Enter your Data Center username"
                                    : "Paste your username"
                            }
                        />
                    </FormControl.Input>
                </FormControl.Root>

                {!selfhosted && (
                    <FormControl.Root>
                        <FormControl.Label htmlFor="bitbucket-email-input">
                            Email
                        </FormControl.Label>
                        <FormControl.Input>
                            <Input
                                type="email"
                                value={email}
                                error={error.message}
                                id="bitbucket-email-input"
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder="Enter your email address"
                            />
                        </FormControl.Input>
                    </FormControl.Root>
                )}

                {!selfhosted && (
                    <FormControl.Root>
                        <FormControl.Label htmlFor="bitbucket-api-token-input">
                            API token
                        </FormControl.Label>
                        <FormControl.Input>
                            <Input
                                type="password"
                                value={token}
                                error={error.message}
                                id="bitbucket-api-token-input"
                                onChange={(e) => setToken(e.target.value)}
                                placeholder="Paste your API token"
                            />
                        </FormControl.Input>

                        <FormControl.Error>{error.message}</FormControl.Error>
                    </FormControl.Root>
                )}

                {selfhosted && (
                    <FormControl.Root>
                        <FormControl.Label htmlFor="bitbucket-basic-auth-password-input">
                            Basic auth password
                        </FormControl.Label>

                        <FormControl.Input>
                            <Input
                                type="password"
                                value={dataCenterPassword}
                                error={error.message}
                                id="bitbucket-basic-auth-password-input"
                                onChange={(e) =>
                                    setDataCenterPassword(e.target.value)
                                }
                                placeholder="Enter your Data Center password"
                            />
                        </FormControl.Input>
                    </FormControl.Root>
                )}

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
                                <FormControl.Label className="mb-0 flex items-center gap-2">
                                    <span>Bitbucket Data Center</span>
                                    <Badge
                                        variant="helper"
                                        className="h-6 px-2 text-[10px] uppercase">
                                        Alpha
                                    </Badge>
                                </FormControl.Label>
                            </Button>
                        </CollapsibleTrigger>

                        <div className="pointer-events-none absolute inset-y-0 right-6 flex items-center">
                            <Switch decorative checked={selfhosted} />
                        </div>
                    </div>

                    <CollapsibleContent>
                        <Card color="lv1">
                            <CardHeader>
                                <FormControl.Root>
                                    <FormControl.Label htmlFor="cards-bitbucket-selfhost-url">
                                        Bitbucket Data Center Base URL
                                    </FormControl.Label>

                                    <FormControl.Input>
                                        <Input
                                            id="cards-bitbucket-selfhost-url"
                                            value={selfHostedUrl}
                                            onChange={(event) =>
                                                setSelfHostedUrl(
                                                    event.target.value,
                                                )
                                            }
                                            placeholder="https://bitbucket.your-company.com"
                                        />
                                    </FormControl.Input>
                                </FormControl.Root>
                            </CardHeader>
                        </Card>
                    </CollapsibleContent>
                </Collapsible>

                <DialogFooter>
                    <Button
                        size="md"
                        variant="primary"
                        onClick={saveToken}
                        loading={loadingSaveToken}
                        disabled={
                            !username ||
                            !!error.message ||
                            (!selfhosted
                                ? !token || !email
                                : !selfHostedUrl.trim() ||
                                  !dataCenterPassword.trim())
                        }>
                        Save Token
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
