"use client";

import { useMemo, useState } from "react";
import { Button } from "@components/ui/button";
import { FormControl } from "@components/ui/form-control";
import { Heading } from "@components/ui/heading";
import { Input } from "@components/ui/input";
import { Link } from "@components/ui/link";
import { MultiStep, useMultiStep } from "@components/ui/multi-step";
import { zodResolver } from "@hookform/resolvers/zod";
import { useDebouncedCallback } from "@hooks/use-debounced-callback";
import {
    ArrowLeft,
    ArrowRight,
    CheckIcon,
    Eye,
    EyeClosed,
    LogInIcon,
} from "lucide-react";
import { signIn } from "next-auth/react";
import {
    Controller,
    FormProvider,
    useForm,
    useFormContext,
} from "react-hook-form";
import type { TODO } from "src/core/types";
import { cn } from "src/core/utils/components";
import { checkForEmailExistence, registerUser } from "src/lib/auth/fetchers";
import { z } from "zod";

import { OAuthButtons } from "./oauth";

const GetStarted = () => {
    const multiStep = useMultiStep();
    const form = useFormContext<z.infer<typeof formSchema>>();
    const emailFieldState = form.getFieldState("email", form.formState);

    const { invalid: isEmailInvalid, isDirty: isEmailFilled } = emailFieldState;

    const debouncedCallback = useDebouncedCallback((email: string) => {
        form.setValue("email", email, {
            shouldValidate: true,
            shouldDirty: true,
            shouldTouch: true,
        });
    });

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
                <Heading variant="h2">Get Started Now</Heading>

                <p className="text-text-secondary text-sm">
                    Start automating reviews in minutes and save hours every
                    sprint!
                </p>
            </div>

            <OAuthButtons isSignUp />

            <div className="mt-4 flex w-full flex-row items-center">
                <hr className="flex-1 border-[#6A57A433]" />
                <p className="text-text-secondary px-6 text-[13px]">
                    Or sign up with
                </p>
                <hr className="flex-1 border-[#6A57A433]" />
            </div>

            <form
                className="flex w-full flex-col gap-4"
                onSubmit={(ev) => {
                    ev.preventDefault();
                    multiStep.navigateTo("with-email");
                }}>
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
                                    value={undefined}
                                    id={field.name}
                                    type="email"
                                    defaultValue={field.value}
                                    placeholder="Enter a corporate email address"
                                    error={fieldState.error}
                                    autoCapitalize="none"
                                    autoCorrect="off"
                                    autoComplete="email"
                                    onChange={(ev) =>
                                        debouncedCallback(ev.target.value)
                                    }
                                    disabled={
                                        formState.isSubmitting || field.disabled
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
                    rightIcon={<ArrowRight />}
                    disabled={!isEmailFilled || isEmailInvalid}>
                    Continue
                </Button>
            </form>

            <p className="text-text-secondary text-center text-xs">
                By creating an account, you agree to our{" "}
                <Link target="_blank" href="https://kodus.io/en/terms-of-use/">
                    Terms of Service
                </Link>{" "}
                and{" "}
                <Link
                    target="_blank"
                    href="https://kodus.io/en/privacy-policy/">
                    Privacy Policy
                </Link>
                .
            </p>
        </div>
    );
};

const WithEmail = () => {
    const multiStep = useMultiStep();
    const form = useFormContext<z.infer<typeof formSchema>>();

    const [typePassword, setTypePassword] = useState<"text" | "password">(
        "password",
    );

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

    const { isValid: isFormValid, isSubmitting: isFormSubmitting } =
        form.formState;

    const onSubmit = form.handleSubmit(async (data) => {
        try {
            const { name, password, email } = data;

            await registerUser({ name, email, password });

            await signIn("credentials", {
                email,
                password,
                redirect: true,
                redirectTo: "/setup",
            });
        } catch (err: TODO) {
            if (err?.response?.status === 409) {
                if (err?.response?.data?.error_key === "DUPLICATE_USER_EMAIL") {
                    form.setError("email", {
                        message:
                            "An account using this email address is already registered.",
                    });
                }
            }
        }
    });

    return (
        <div className="flex flex-col gap-10">
            <Button
                size="sm"
                variant="helper"
                className="text-xs"
                leftIcon={<ArrowLeft />}
                onClick={() => multiStep.back()}>
                Back to Sign Up
            </Button>

            <div className="flex flex-col gap-2">
                <Heading variant="h2">Sign up with e-mail</Heading>

                <p className="text-text-secondary text-sm">
                    Start automating reviews in minutes and save hours every
                    sprint!
                </p>
            </div>

            <form className="flex flex-col gap-6" onSubmit={onSubmit}>
                <Controller
                    name="name"
                    control={form.control}
                    render={({ field, fieldState, formState }) => (
                        <FormControl.Root>
                            <FormControl.Label htmlFor={field.name}>
                                How can we call you?
                            </FormControl.Label>

                            <FormControl.Input>
                                <Input
                                    {...field}
                                    id={field.name}
                                    placeholder="Enter your name"
                                    error={fieldState.error}
                                    autoCapitalize="none"
                                    autoCorrect="off"
                                    autoComplete="given-name"
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
                    disabled={!isFormValid}
                    rightIcon={<LogInIcon />}
                    loading={isFormSubmitting}>
                    Sign up
                </Button>

                <p className="text-text-secondary mt-4 text-center text-xs">
                    By creating an account, you agree to our{" "}
                    <Link
                        target="_blank"
                        href="https://kodus.io/en/terms-of-use/">
                        Terms of Service
                    </Link>{" "}
                    and{" "}
                    <Link
                        target="_blank"
                        href="https://kodus.io/en/privacy-policy/">
                        Privacy Policy
                    </Link>
                    .
                </p>
            </form>
        </div>
    );
};

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
        email: z
            .email({
                error: "Invalid email address",
            })
            .min(1, {
                error: "Enter your email",
            })
            .refine(
                (email) => {
                    const [, domain] = email.split("@");
                    return (
                        domain &&
                        ![
                            "gmail.com",
                            "hotmail.com",
                            "hotmail.com.br",
                            "outlook.com",
                            "outlook.com.br",
                            "yahoo.com",
                        ].includes(domain.toLowerCase())
                    );
                },
                {
                    error: "Please use a corporate email address",
                },
            )
            .refine(async (email) => {
                try {
                    await checkForEmailExistence(email);
                    return true;
                } catch (error) {
                    console.error("Error checking email existence:", error);
                    return false;
                }
            }, "The email is already in use"),
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

export const RegisterPageContent = () => {
    const form = useForm<z.infer<typeof formSchema>>({
        resolver: zodResolver(formSchema, { async: true }, { mode: "async" }),
        mode: "all",
        defaultValues: {
            name: "",
            email: "",
            password: "",
            confirmPassword: "",
        },
    });

    return (
        <FormProvider {...form}>
            <MultiStep
                initialStep="get-started"
                steps={{
                    "get-started": GetStarted,
                    "with-email": WithEmail,
                }}
            />
        </FormProvider>
    );
};
