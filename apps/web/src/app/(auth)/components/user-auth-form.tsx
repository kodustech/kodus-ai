"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardHeader } from "@components/ui/card";
import { FormControl } from "@components/ui/form-control";
import { toast } from "@components/ui/toaster/use-toast";
import { zodResolver } from "@hookform/resolvers/zod";
import {
    AlertTriangleIcon,
    ArrowRight,
    Eye,
    EyeClosed,
    LogInIcon,
} from "lucide-react";
import { signIn } from "next-auth/react";
import { Controller, useForm } from "react-hook-form";
import { Button } from "src/core/components/ui/button";
import { Input } from "src/core/components/ui/input";
import { ssoCheck, ssoLogin } from "src/lib/auth/fetchers";
import { z } from "zod";

const signInFormSchema = z.object({
    email: z
        .string()
        .trim()
        .pipe(
            z.email({
                error: "Please use a valid email address",
            }),
        ),
    password: z.string(),
});

type SignInFormSchema = z.infer<typeof signInFormSchema>;

type AuthStep = "email" | "sso-choice" | "password";

export function UserAuthForm() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const callbackUrl = searchParams.get("callbackUrl");
    const reason = searchParams.get("reason");
    const reasonMessageParam = searchParams.get("reasonMessage");

    const [step, setStep] = useState<AuthStep>("email");
    const [typePassword, setTypePassword] = useState<"password" | "text">(
        "password",
    );
    const [isCheckingSSO, setIsCheckingSSO] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [ssoAvailable, setSsoAvailable] = useState<{
        active: boolean;
        organizationId: string;
    } | null>(null);

    const isError = searchParams?.has("error") ?? false;

    const getReasonMessage = () => {
        switch (reason) {
            case "removed":
                return "Your account has been removed from the organization.";
            case "inactive":
                return "Your account is inactive. Please contact your administrator.";
            case "sso-config-not-found":
                return "SSO is not configured for this organization. Contact your administrator.";
            case "sso-invalid-email-assertion":
                return "Your identity provider did not send a valid email claim. Contact your administrator.";
            case "sso-invalid-assertion":
                return "The SSO response could not be validated. Please retry or contact your administrator.";
            case "sso-expired-request":
                return "The SSO request expired. Start sign in again.";
            case "sso-auth-failed":
                return "SSO authentication failed. Please try again or contact your administrator.";
            default:
                return null;
        }
    };

    const reasonMessage = getReasonMessage();

    const detailedReasonMessage = (() => {
        if (!reasonMessageParam) {
            return null;
        }

        try {
            return decodeURIComponent(reasonMessageParam);
        } catch {
            return reasonMessageParam;
        }
    })();

    const displayReasonMessage = detailedReasonMessage || reasonMessage;

    useEffect(() => {
        if (callbackUrl?.includes("setup_action=install")) {
            const urlParams = new URL(callbackUrl);
            const installationId =
                urlParams.searchParams.get("installation_id");
            router.push(
                `/github-integration?installation_id=${installationId}`,
            );
        }
    }, [callbackUrl, router]);

    const form = useForm<SignInFormSchema>({
        mode: "onSubmit",
        resolver: zodResolver(signInFormSchema),
        defaultValues: { email: "", password: "" },
    });

    const checkSsoAvailability = useCallback(async (email: string) => {
        try {
            const domain = email.split("@")[1];
            const response = await ssoCheck(domain);
            setSsoAvailable(response);
            return response;
        } catch (error) {
            setSsoAvailable(null);
            return null;
        }
    }, []);

    const handleEmailStep = useCallback(
        async (email: string) => {
            setIsCheckingSSO(true);
            const ssoResponse = await checkSsoAvailability(email);
            setIsCheckingSSO(false);

            if (ssoResponse?.active && ssoResponse.organizationId) {
                setStep("sso-choice");
            } else {
                setStep("password");
            }
        },
        [checkSsoAvailability],
    );

    const handleSsoLogin = useCallback(async () => {
        if (!ssoAvailable?.organizationId) return;
        setIsSubmitting(true);
        try {
            // ssoLogin sets window.location.href on success — control
            // never returns. We only reach the catch when the install
            // is misconfigured (e.g. API_URL missing) so the throw is
            // the only path back here.
            await ssoLogin(ssoAvailable.organizationId);
        } catch (err) {
            toast({
                title: "SSO unavailable",
                description:
                    err instanceof Error
                        ? err.message
                        : "Failed to start SSO login.",
                variant: "danger",
            });
            setIsSubmitting(false);
        }
    }, [ssoAvailable]);

    const handlePasswordLogin = useCallback(
        async (email: string, password: string) => {
            setIsSubmitting(true);
            await signIn("credentials", {
                email,
                password,
                redirect: true,
                redirectTo: callbackUrl ?? "/",
            });
            setIsSubmitting(false);
        },
        [callbackUrl],
    );

    const handleSubmit = async (e: { preventDefault: () => void }) => {
        e.preventDefault();

        if (step === "email") {
            const isValid = await form.trigger("email");
            if (!isValid) return;

            const email = form.getValues("email");
            await handleEmailStep(email);
        } else if (step === "password") {
            const isValid = await form.trigger();
            if (!isValid) return;

            const { email, password } = form.getValues();
            await handlePasswordLogin(email, password);
        }
    };

    const resetFlow = useCallback(() => {
        setStep("email");
        setSsoAvailable(null);
        form.setValue("password", "");
        form.clearErrors();
    }, [form]);

    return (
        <form onSubmit={handleSubmit} className="grid w-full gap-6">
            {displayReasonMessage && (
                <Card className="bg-danger/10 text-sm">
                    <CardHeader className="flex-row items-center gap-4">
                        <AlertTriangleIcon className="text-danger size-5" />
                        <span>{displayReasonMessage}</span>
                    </CardHeader>
                </Card>
            )}

            {isError && !displayReasonMessage && (
                <Card className="bg-warning/10 text-sm">
                    <CardHeader className="flex-row items-center gap-4">
                        <AlertTriangleIcon className="text-warning size-5" />
                        <span>No user found with this email and password.</span>
                    </CardHeader>
                </Card>
            )}

            {/* Email Field - Always Visible, but readOnly if not in step 1 */}
            <Controller
                name="email"
                control={form.control}
                render={({ field, fieldState }) => (
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
                                    isSubmitting ||
                                    isCheckingSSO ||
                                    step !== "email"
                                }
                                rightIcon={
                                    step !== "email" ? (
                                        <Button
                                            variant="helper"
                                            size="xs"
                                            type="button"
                                            onClick={resetFlow}
                                            className="text-muted-foreground hover:text-primary text-xs">
                                            Change
                                        </Button>
                                    ) : undefined
                                }
                            />
                        </FormControl.Input>
                        <FormControl.Error>
                            {fieldState.error?.message}
                        </FormControl.Error>
                    </FormControl.Root>
                )}
            />

            {/* Step 2: SSO */}
            {step === "sso-choice" && (
                <div className="animate-in fade-in slide-in-from-top-2 space-y-4">
                    <div className="bg-muted text-muted-foreground rounded-md p-4 text-sm">
                        Single Sign-On is available for{" "}
                        <strong>{form.getValues("email").split("@")[1]}</strong>
                        .
                    </div>

                    <Button
                        type="button"
                        variant="secondary"
                        size="lg"
                        className="w-full"
                        onClick={handleSsoLogin}
                        disabled={isSubmitting}
                        rightIcon={<ArrowRight />}
                        loading={isSubmitting}>
                        Continue with SSO
                    </Button>
                </div>
            )}

            {/* Step 3: Password Input */}
            {step === "password" && (
                <div className="animate-in fade-in slide-in-from-top-2 space-y-6">
                    <Controller
                        name="password"
                        control={form.control}
                        render={({ field, fieldState }) => (
                            <FormControl.Root>
                                <FormControl.Label htmlFor={field.name}>
                                    Password
                                </FormControl.Label>

                                <FormControl.Input>
                                    <Input
                                        {...field}
                                        id={field.name}
                                        type={typePassword}
                                        placeholder="Type your password"
                                        error={fieldState.error}
                                        autoComplete="current-password"
                                        disabled={isSubmitting}
                                        rightIcon={
                                            <Button
                                                variant="helper"
                                                size="icon-sm"
                                                type="button"
                                                className="-mr-2"
                                                onClick={() =>
                                                    setTypePassword((prev) =>
                                                        prev === "password"
                                                            ? "text"
                                                            : "password",
                                                    )
                                                }>
                                                {typePassword === "password" ? (
                                                    <EyeClosed className="size-4" />
                                                ) : (
                                                    <Eye className="size-4" />
                                                )}
                                            </Button>
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
                        disabled={isSubmitting}
                        rightIcon={<LogInIcon />}
                        loading={isSubmitting}>
                        Sign in
                    </Button>
                </div>
            )}

            {/* Step 1: Initial Continue Button */}
            {step === "email" && (
                <Button
                    size="lg"
                    type="submit"
                    variant="primary"
                    className="w-full"
                    disabled={isSubmitting || isCheckingSSO}
                    rightIcon={<ArrowRight />}
                    loading={isSubmitting || isCheckingSSO}>
                    Continue
                </Button>
            )}
        </form>
    );
}
