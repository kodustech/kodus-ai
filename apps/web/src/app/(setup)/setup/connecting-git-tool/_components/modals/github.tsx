"use client";

import { Button } from "@components/ui/button";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { KodyReviewPreview } from "@components/ui/kody-review-preview";
import { magicModal } from "@components/ui/magic-modal";
import { zodResolver } from "@hookform/resolvers/zod";
import { createCodeManagementIntegration } from "@services/codeManagement/fetch";
import { AxiosError } from "axios";
import { SaveIcon } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
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
import { captureSegmentEvent } from "src/core/utils/segment";
import { z } from "zod";

const tokenFormSchema = z.object({
    token: z.string().min(1, {
        error: "Enter a Token",
    }),
});

function getUsernameFromEmail(email: string): string {
    return email.split("@")[0] || email;
}

export const GithubTokenModal = (props: {
    teamId: string;
    userId: string;
    userEmail: string;
}) => {
    const form = useForm({
        resolver: zodResolver(tokenFormSchema),
        mode: "all",
        defaultValues: {
            token: "",
        },
    });

    const submit = async (data: z.infer<typeof tokenFormSchema>) => {
        magicModal.lock();

        try {
            await createCodeManagementIntegration({
                integrationType: PlatformType.GITHUB,
                authMode: AuthMode.TOKEN,
                token: data.token,
                organizationAndTeamData: {
                    teamId: props.teamId,
                },
            });

            captureSegmentEvent({
                userId: props?.userId!,
                event: "setup_git_integration_success",
                properties: {
                    platform: "github",
                    method: "token",
                    teamId: props?.teamId,
                },
            });

            magicModal.hide(true);
        } catch (error) {
            magicModal.unlock();

            if (error instanceof AxiosError && error.status === 400) {
                form.setError("token", {
                    type: "custom",
                    message: "Invalid Token",
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
                    </div>

                    <div className="flex flex-col gap-4">
                        <Controller
                            name="token"
                            control={form.control}
                            render={({ field, fieldState }) => (
                                <FormControl.Root>
                                    <FormControl.Input>
                                        <Input
                                            {...field}
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
                            disabled={!formIsValid}>
                            Validate and save
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};
