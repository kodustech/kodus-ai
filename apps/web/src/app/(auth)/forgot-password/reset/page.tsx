"use client";

import { Suspense, useMemo, useState } from "react";
import { Metadata } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@components/ui/button";
import { FormControl } from "@components/ui/form-control";
import { SvgKodus } from "@components/ui/icons/SvgKodus";
import { Input } from "@components/ui/input";
import { Link } from "@components/ui/link";
import { Page } from "@components/ui/page";
import { toast } from "@components/ui/toaster/use-toast";
import { zodResolver } from "@hookform/resolvers/zod";
import { CheckIcon, Eye, EyeClosed, LogInIcon } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { cn } from "src/core/utils/components";
import { resetPassword, sendForgotPasswordMail } from "src/lib/auth/fetchers";
import { z } from "zod";

import AuthPageHeader from "../../components/auth-page-header";

const resetPassFormSchema = z
    .object({
        password: z
            .string({
                error: (issue) =>
                    issue.input === undefined ? "Enter a password" : undefined,
            })
            .min(8, {
                error: "Invalid password",
            })
            .regex(/^(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).+$/, {
                error: "Password must include at least 1 uppercase letter, 1 number, and 1 special character",
            }),
        confirmPassword: z.string({
            error: (issue) =>
                issue.input === undefined ? "Confirm your password" : undefined,
        }),
    })
    .superRefine(({ confirmPassword, password }, ctx) => {
        if (confirmPassword !== password) {
            ctx.addIssue({
                code: "custom",
                message: "Passwords must match",
                path: ["confirmPassword"],
            });
        }
    });

type ResetPassFormSchema = z.infer<typeof resetPassFormSchema>;

function ResetPasswordForm() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const [typePassword, setTypePassword] = useState<"password" | "text">(
        "password",
    );

    const form = useForm<ResetPassFormSchema>({
        mode: "all",
        resolver: zodResolver(resetPassFormSchema),
    });

    const onSubmit = form.handleSubmit(async (data) => {
        try {
            const { password } = data;
            const token = searchParams.get("token");
            if (!token) {
                toast({
                    title: "Error",
                    description: "Reset password token not found",
                    variant: "danger",
                });
                router.push("/forgot-password");
                return;
            }

            await resetPassword(password, token);
            router.push("/forgot-password/reset/success");
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

    const password = form.watch("password");
    const passwordRules = useMemo(
        () => ({
            hasEightChars: {
                text: "8 characters",
                valid: password?.split("").length >= 8,
            },
            hasUppercaseLetter: {
                text: "1 uppercase letter",
                valid: /[A-Z]/.test(password),
            },
            hasNumber: {
                text: "1 number",
                valid: /\d/.test(password),
            },
            hasSymbol: {
                text: "1 symbol",
                valid: /[^a-zA-Z0-9\s]/.test(password),
            },
        }),
        [password],
    );

    return (
        <form onSubmit={onSubmit} className="grid w-full gap-6">
            <Controller
                name="password"
                control={form.control}
                render={({ field, fieldState, formState }) => (
                    <FormControl.Root>
                        <FormControl.Label htmlFor={field.name}>
                            Password
                        </FormControl.Label>

                        <FormControl.Input>
                            <Input
                                {...field}
                                id={field.name}
                                type={typePassword}
                                placeholder="Create your password"
                                error={fieldState.error}
                                autoCapitalize="none"
                                autoCorrect="off"
                                autoComplete="off"
                                disabled={
                                    formState.isSubmitting ||
                                    formState.isLoading ||
                                    field.disabled
                                }
                                rightIcon={
                                    <Button
                                        size="icon-sm"
                                        variant="helper"
                                        type="button"
                                        className="-mr-2"
                                        onClick={() =>
                                            setTypePassword((typePassword) =>
                                                typePassword === "password"
                                                    ? "text"
                                                    : "password",
                                            )
                                        }>
                                        {typePassword === "password" ? (
                                            <EyeClosed />
                                        ) : (
                                            <Eye />
                                        )}
                                    </Button>
                                }
                            />
                        </FormControl.Input>

                        <FormControl.Error>
                            {fieldState.error?.message}
                        </FormControl.Error>

                        <FormControl.Helper className="mt-2 flex flex-col gap-1">
                            <span>Password must have at least:</span>
                            <div className="flex flex-row flex-wrap gap-1">
                                {Object.values(passwordRules).map(
                                    (rule, index) => (
                                        <div
                                            key={index}
                                            className={cn(
                                                "flex items-center gap-1 rounded-full px-2 py-1",
                                                "border border-[#6A57A433]",
                                                rule.valid &&
                                                    "border-success/20",
                                            )}>
                                            <div className="w-3 text-center">
                                                {rule.valid ? (
                                                    <CheckIcon className="text-success size-3" />
                                                ) : (
                                                    <span>•</span>
                                                )}
                                            </div>

                                            <span
                                                className={cn(
                                                    rule.valid &&
                                                        "text-success-foreground",
                                                )}>
                                                {rule.text}
                                            </span>
                                        </div>
                                    ),
                                )}
                            </div>
                        </FormControl.Helper>
                    </FormControl.Root>
                )}
            />

            <Controller
                name="confirmPassword"
                control={form.control}
                render={({ field, fieldState, formState }) => (
                    <FormControl.Root>
                        <FormControl.Label htmlFor={field.name}>
                            Confirm Password
                        </FormControl.Label>

                        <FormControl.Input>
                            <Input
                                {...field}
                                id={field.name}
                                type="password"
                                placeholder="Re-enter your password"
                                error={fieldState.error}
                                autoCapitalize="none"
                                autoCorrect="off"
                                autoComplete="off"
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
                loading={formIsLoading || formIsSubmitting || formIsValidating}>
                Reset Password
            </Button>
        </form>
    );
}

export default function ForgotPasswordPage() {
    return (
        <Page.Root className="flex h-full w-full flex-col items-center overflow-auto py-20">
            <div className="flex w-[90%] flex-1 flex-col items-center justify-center gap-10 md:max-w-[500px]">
                <AuthPageHeader />

                <Page.Content className="flex-none gap-4">
                    <Suspense fallback={<div>Loading...</div>}>
                        <ResetPasswordForm />
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
