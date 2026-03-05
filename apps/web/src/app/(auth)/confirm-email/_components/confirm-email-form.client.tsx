"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@components/ui/button";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { toast } from "@components/ui/toaster/use-toast";
import { zodResolver } from "@hookform/resolvers/zod";
import { isAxiosError } from "axios";
import { CheckIcon } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { confirmEmail } from "src/lib/auth/fetchers";
import { z } from "zod";

const confirmEmailFormSchema = z.object({
    token: z
        .string({
            error: (issue) =>
                issue.input === undefined ? "Token is required" : undefined,
        })
        .min(1, {
            error: "Token is required",
        }),
});

type ConfirmEmailFormSchema = z.infer<typeof confirmEmailFormSchema>;

type ConfirmEmailFormProps = {
    onSuccess?: () => Promise<void> | void;
    submitLabel?: string;
};

export const ConfirmEmailForm = ({
    onSuccess,
    submitLabel = "Confirm Email",
}: ConfirmEmailFormProps) => {
    const searchParams = useSearchParams();
    const form = useForm<ConfirmEmailFormSchema>({
        mode: "all",
        resolver: zodResolver(confirmEmailFormSchema),
    });
    const { setValue } = form;
    const [autoSubmitting, setAutoSubmitting] = useState(false);
    const lastTokenRef = useRef<string | null>(null);

    const submitToken = useCallback(
        async (token: string, { auto }: { auto?: boolean } = {}) => {
            if (auto) setAutoSubmitting(true);
            try {
                await confirmEmail(token);
                toast({
                    title: "Email confirmed",
                    description: "Your email was confirmed successfully.",
                    variant: "success",
                });
                await onSuccess?.();
            } catch (error) {
                if (isAxiosError(error) && error.response?.status === 401) {
                    toast({
                        title: "Sign in required",
                        description:
                            "You must be logged in to confirm or resend your email.",
                        variant: "danger",
                    });
                    return;
                }
                toast({
                    title: "Error",
                    description:
                        "We couldn't confirm your email. Please check the token and try again.",
                    variant: "danger",
                });
            } finally {
                if (auto) setAutoSubmitting(false);
            }
        },
        [onSuccess],
    );

    const onSubmit = form.handleSubmit(async ({ token }) => {
        await submitToken(token);
    });

    useEffect(() => {
        const token = searchParams.get("token");
        if (!token || lastTokenRef.current === token) {
            return;
        }

        lastTokenRef.current = token;
        setValue("token", token, {
            shouldValidate: true,
            shouldDirty: true,
        });

        void submitToken(token, { auto: true });
    }, [searchParams, setValue, submitToken]);

    const {
        isLoading: formIsLoading,
        isValidating: formIsValidating,
        isValid: formIsValid,
        isSubmitting: formIsSubmitting,
    } = form.formState;

    return (
        <Suspense>
            <form onSubmit={onSubmit} className="grid w-full gap-6">
                <Controller
                    name="token"
                    control={form.control}
                    render={({ field, fieldState, formState }) => (
                        <FormControl.Root>
                            <FormControl.Label htmlFor={field.name}>
                                Token
                            </FormControl.Label>

                            <FormControl.Input>
                                <Input
                                    {...field}
                                    id={field.name}
                                    placeholder="Paste your confirmation token"
                                    error={fieldState.error}
                                    autoCapitalize="none"
                                    autoCorrect="off"
                                    disabled={
                                        formState.isSubmitting ||
                                        formState.isLoading ||
                                        field.disabled
                                    }
                                />
                            </FormControl.Input>

                            <FormControl.Error>
                                {fieldState.error?.message}
                            </FormControl.Error>
                        </FormControl.Root>
                    )}
                />
                <Button
                    size="lg"
                    type="submit"
                    variant="primary"
                    className="w-full"
                    disabled={!formIsValid}
                    rightIcon={<CheckIcon />}
                    loading={
                        formIsLoading ||
                        formIsSubmitting ||
                        formIsValidating ||
                        autoSubmitting
                    }>
                    {submitLabel}
                </Button>
            </form>
        </Suspense>
    );
};
