"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { FormControl } from "@components/ui/form-control";
import { SvgCheckList } from "@components/ui/icons/SvgCheckList";
import { toast } from "@components/ui/toaster/use-toast";
import { zodResolver } from "@hookform/resolvers/zod";
import { Eye, EyeClosed, LogInIcon } from "lucide-react";
import { signIn } from "next-auth/react";
import { Controller, useForm } from "react-hook-form";
import { Button } from "src/core/components/ui/button";
import { Input } from "src/core/components/ui/input";
import { cn } from "src/core/utils/components";
import { completeUserInvitation } from "src/lib/auth/fetchers";
import { z } from "zod";

const formSchema = z
    .object({
        name: z
            .string()
            .trim()
            .min(1, {
                error: "Enter your name",
            })
            .regex(/^[\p{L}\s'-]+$/u, {
                error: "Name can only contain letters, spaces, hyphens and apostrophes",
            }),
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

export const AcceptInviteForm = (props: {
    email: string;
    organizationName: string;
    inviteId: string;
}) => {
    const searchParams = useSearchParams();
    const callbackUrl = searchParams.get("callbackUrl");
    const [typePassword, setTypePassword] = useState<"password" | "text">(
        "password",
    );

    const form = useForm<z.infer<typeof formSchema>>({
        mode: "all",
        resolver: zodResolver(formSchema),
        defaultValues: {
            name: "",
            password: "",
            confirmPassword: "",
        },
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

    const onSubmit = form.handleSubmit(async (data) => {
        const { password, name } = data;

        const register = await completeUserInvitation({
            name,
            password,
            uuid: props.inviteId,
        });

        if (register?.data?.statusCode === 201) {
            toast({
                description: "Registration completed!",
                variant: "success",
            });

            await signIn("credentials", {
                email: props.email,
                password,
                redirect: true,
                redirectTo: callbackUrl ?? "/",
            });
        }
    });

    return (
        <form onSubmit={onSubmit} className="grid w-full gap-6">
            <Controller
                name="name"
                control={form.control}
                render={({ field, fieldState, formState }) => (
                    <FormControl.Root>
                        <FormControl.Label htmlFor={field.name}>
                            Name
                        </FormControl.Label>

                        <FormControl.Input>
                            <Input
                                {...field}
                                id={field.name}
                                placeholder="Enter your name"
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

            <Controller
                name="password"
                control={form.control}
                render={({ field, fieldState, formState }) => (
                    <FormControl.Root>
                        <FormControl.Label htmlFor={field.name}>
                            Password
                        </FormControl.Label>

                        <FormControl.Input>
                            <div className="relative">
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
                                                setTypePassword(
                                                    (typePassword) =>
                                                        typePassword ===
                                                        "password"
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
                            </div>
                        </FormControl.Input>

                        <FormControl.Error>
                            {fieldState.error?.message}
                        </FormControl.Error>

                        <FormControl.Helper className="mt-2 flex flex-col gap-1">
                            <span>You must have at least:</span>
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
                                                    <SvgCheckList />
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
                Accept invite
            </Button>
        </form>
    );
};
