"use client";

import { Button } from "@components/ui/button";
import { Card, CardHeader } from "@components/ui/card";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { KodyReviewPreview } from "@components/ui/kody-review-preview";
import { magicModal } from "@components/ui/magic-modal";
import { zodResolver } from "@hookform/resolvers/zod";
import { createCodeManagementIntegration } from "@services/codeManagement/fetch";
import { AxiosError } from "axios";
import { SaveIcon } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "src/core/components/ui/dialog";
import { AuthMode, PlatformType } from "src/core/types";
import { z } from "zod";

const tokenFormSchema = z.object({
    token: z.string().min(1, {
        error: "Enter a Token",
    }),
    hostUrl: z.string().url({
        error: "Enter a valid URL",
    }),
});

function getUsernameFromEmail(email: string): string {
    return email.split("@")[0] || email;
}

export const ForgejoTokenModal = (props: {
    teamId: string;
    userId: string;
    userEmail: string;
}) => {
    const form = useForm({
        resolver: zodResolver(tokenFormSchema),
        mode: "all",
        defaultValues: {
            token: "",
            hostUrl: "",
        },
    });

    const submit = async (data: z.infer<typeof tokenFormSchema>) => {
        magicModal.lock();

        try {
            // Ensure the host URL doesn't have a trailing slash
            const normalizedHostUrl = data.hostUrl.replace(/\/+$/, "");

            await createCodeManagementIntegration({
                integrationType: PlatformType.FORGEJO,
                authMode: AuthMode.TOKEN,
                token: data.token,
                host: normalizedHostUrl,
                organizationAndTeamData: {
                    teamId: props.teamId,
                },
            });

            magicModal.hide(true);
        } catch (error) {
            magicModal.unlock();

            if (error instanceof AxiosError && error.status === 400) {
                form.setError("token", {
                    type: "custom",
                    message: "Invalid Token or Host URL",
                });
            }
        }
    };

    const {
        isDirty: formIsDirty,
        isValid: formIsValid,
        isSubmitting: formIsSubmitting,
    } = form.formState;

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent>
                <form onSubmit={form.handleSubmit(submit)}>
                    <DialogHeader>
                        <DialogTitle>Forgejo Personal Access Token</DialogTitle>
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
                    </div>

                    <div className="flex flex-col gap-4">
                        <Card color="lv1">
                            <CardHeader className="flex flex-col gap-4">
                                <Controller
                                    name="hostUrl"
                                    control={form.control}
                                    render={({ field, fieldState }) => (
                                        <FormControl.Root>
                                            <FormControl.Label
                                                htmlFor={field.name}>
                                                Forgejo Instance URL
                                            </FormControl.Label>

                                            <FormControl.Input>
                                                <Input
                                                    {...field}
                                                    id={field.name}
                                                    type="url"
                                                    error={fieldState.error}
                                                    placeholder="https://forgejo.example.com"
                                                />
                                            </FormControl.Input>

                                            <FormControl.Helper>
                                                The URL of your Forgejo instance
                                            </FormControl.Helper>

                                            <FormControl.Error>
                                                {fieldState.error?.message}
                                            </FormControl.Error>
                                        </FormControl.Root>
                                    )}
                                />

                                <Controller
                                    name="token"
                                    control={form.control}
                                    render={({ field, fieldState }) => (
                                        <FormControl.Root>
                                            <FormControl.Label
                                                htmlFor={field.name}>
                                                Personal Access Token
                                            </FormControl.Label>

                                            <FormControl.Input>
                                                <Input
                                                    {...field}
                                                    id={field.name}
                                                    type="password"
                                                    error={fieldState.error}
                                                    placeholder="Paste your Token here"
                                                />
                                            </FormControl.Input>

                                            <FormControl.Error>
                                                {fieldState.error?.message}
                                            </FormControl.Error>
                                        </FormControl.Root>
                                    )}
                                />
                            </CardHeader>
                        </Card>

                        <div className="bg-card-lv2 rounded-lg border p-4 text-sm">
                            <p className="mb-2 font-medium">
                                Required Token Permissions:
                            </p>
                            <ul className="text-text-secondary list-inside list-disc space-y-1">
                                <li>
                                    <code>user read</code> - Read user profile
                                    (required for authentication)
                                </li>
                                <li>
                                    <code>organization read</code> - Read user
                                    organization profile (required for
                                    authentication)
                                </li>
                                <li>
                                    <code>repository read:write</code> - Read
                                    and write access to repositories
                                </li>
                                <li>
                                    <code>issue read:write</code> - Create and
                                    update pull request comments
                                </li>
                            </ul>
                        </div>
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
                            disabled={!formIsValid}>
                            Validate and save
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};
