"use client";

import { Suspense, useState } from "react";
import { Metadata } from "next";
import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { FormControl } from "@components/ui/form-control";
import { SvgKodus } from "@components/ui/icons/SvgKodus";
import { Input } from "@components/ui/input";
import { Link } from "@components/ui/link";
import { Page } from "@components/ui/page";
import { toast } from "@components/ui/toaster/use-toast";
import { zodResolver } from "@hookform/resolvers/zod";
import { LogInIcon } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { sendForgotPasswordMail } from "src/lib/auth/fetchers";
import { z } from "zod";

import AuthPageHeader from "../components/auth-page-header";

const forgotPasswordFormSchema = z.object({
    email: z.email({
        error: "Please use a valid email address",
    }),
});

type ForgotPasswordFormSchema = z.infer<typeof forgotPasswordFormSchema>;

export default function ForgotPasswordPage() {
    const router = useRouter();
    const form = useForm<ForgotPasswordFormSchema>({
        mode: "all",
        resolver: zodResolver(forgotPasswordFormSchema),
    });

    const onSubmit = form.handleSubmit(async (data) => {
        try {
            await sendForgotPasswordMail(data.email);
            router.push("/forgot-password/email-sent");
        } catch (error) {
            toast({
                title: "Error",
                description:
                    "An error occurred while sending mail. Please try again.",
                variant: "danger",
            });
        }
    });

    const {
        isLoading: formIsLoading,
        isValidating: formIsValidating,
        isValid: formIsValid,
        isSubmitting: formIsSubmitting,
    } = form.formState;
    return (
        <Page.Root className="flex h-full w-full flex-col items-center overflow-auto py-20">
            <div className="flex w-[90%] flex-1 flex-col items-center justify-center gap-10 md:max-w-[500px]">
                <AuthPageHeader />

                <Page.Content className="flex-none gap-4">
                    <Suspense>
                        <form onSubmit={onSubmit} className="grid w-full gap-6">
                            <Controller
                                name="email"
                                control={form.control}
                                render={({ field, fieldState, formState }) => (
                                    <FormControl.Root>
                                        <FormControl.Label htmlFor={field.name}>
                                            Email
                                        </FormControl.Label>

                                        <FormControl.Input>
                                            <Input
                                                {...field}
                                                id={field.name}
                                                type="email"
                                                placeholder="Your corporate email address"
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
                                rightIcon={<LogInIcon />}
                                loading={
                                    formIsLoading ||
                                    formIsSubmitting ||
                                    formIsValidating
                                }>
                                Reset Password
                            </Button>
                        </form>
                    </Suspense>

                    <Link
                        className="mx-auto mt-4 text-center text-sm"
                        href="/sign-in">
                        Back to Log in
                    </Link>
                </Page.Content>
            </div>
        </Page.Root>
    );
}
