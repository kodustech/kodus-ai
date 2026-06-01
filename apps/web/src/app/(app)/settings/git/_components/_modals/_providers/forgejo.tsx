"use client";

import { useEffect, useState, type FormEvent } from "react";
import { GitTokenDocs } from "@components/system/git-token-docs";
import { Button } from "@components/ui/button";
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
import { useAsyncAction } from "@hooks/use-async-action";
import { AxiosError } from "axios";
import { Save } from "lucide-react";

type Props = {
    onSaveToken: (token: string, selfHostedUrl: string) => Promise<void>;
};

export const ForgejoModal = (props: Props) => {
    const [token, setToken] = useState("");
    const [selfHostedUrl, setSelfHostedUrl] = useState("");
    const [error, setError] = useState({ message: "" });

    useEffect(() => {
        setError({ message: "" });
    }, [token, selfHostedUrl]);

    const canSubmit =
        !!token.trim() && !!selfHostedUrl.trim() && !error.message;

    const [saveToken, { loading: loadingSaveToken }] = useAsyncAction(
        async () => {
            magicModal.lock();

            try {
                const normalizedHostUrl = selfHostedUrl
                    .trim()
                    .replace(/\/+$/, "");

                await props.onSaveToken(token, normalizedHostUrl);
                magicModal.hide();
            } catch (error) {
                magicModal.unlock();

                if (error instanceof AxiosError && error.status === 400) {
                    setError({ message: "Invalid Token or Host URL" });
                } else {
                    setError({
                        message: "Failed to connect. Please try again.",
                    });
                }
            }
        },
    );

    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!canSubmit) return;

        void saveToken();
    };

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent>
                <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
                    <DialogHeader>
                        <DialogTitle>
                            <span>Forgejo</span> - New Integration
                        </DialogTitle>
                    </DialogHeader>

                    <FormControl.Root>
                        <FormControl.Label htmlFor="forgejo-host-url-input">
                            Forgejo Instance URL
                        </FormControl.Label>

                        <FormControl.Input>
                            <Input
                                type="url"
                                value={selfHostedUrl}
                                error={error.message}
                                id="forgejo-host-url-input"
                                onChange={(e) =>
                                    setSelfHostedUrl(e.target.value)
                                }
                                placeholder="https://forgejo.example.com"
                            />
                        </FormControl.Input>

                        <FormControl.Helper>
                            The URL of your Forgejo instance
                        </FormControl.Helper>
                    </FormControl.Root>

                    <FormControl.Root>
                        <FormControl.Label htmlFor="forgejo-token-input">
                            Personal Access Token
                        </FormControl.Label>

                        <FormControl.Input>
                            <Input
                                type="password"
                                value={token}
                                error={error.message}
                                id="forgejo-token-input"
                                onChange={(e) => setToken(e.target.value)}
                                placeholder="Paste your Token here"
                            />
                        </FormControl.Input>

                        <FormControl.Error>{error.message}</FormControl.Error>
                    </FormControl.Root>

                    <GitTokenDocs provider="forgejo" />

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
            </DialogContent>
        </Dialog>
    );
};
