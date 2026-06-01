"use client";

import { useState } from "react";
import {
    AlertTriangleIcon,
    CheckCircle2Icon,
    LaptopIcon,
    ShieldCheckIcon,
    TerminalIcon,
    TimerIcon,
} from "lucide-react";
import NextLink from "next/link";

import { Button } from "@components/ui/button";
import { Card } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { SvgKodus } from "@components/ui/icons/SvgKodus";
import { Page } from "@components/ui/page";
import { Spinner } from "@components/ui/spinner";
import {
    useCliLoginInfo,
    useCompleteCliLogin,
} from "@services/cli-auth/hooks";

export function CliAuthorizeClient({
    state,
    userCode,
}: {
    state?: string;
    userCode?: string;
}) {
    const hasIdentifier = Boolean(state || userCode);
    const {
        data: info,
        isLoading,
        isError,
    } = useCliLoginInfo({ state, userCode });

    const completeMutation = useCompleteCliLogin();
    const [completedMode, setCompletedMode] = useState<
        "loopback" | "device" | null
    >(null);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    const expiresInLabel = info?.expiresAt
        ? formatExpiresIn(info.expiresAt)
        : null;

    if (!hasIdentifier) {
        return (
            <Shell>
                <ErrorBlock
                    title="Missing authorization code"
                    description="Open this page from the Kodus CLI by running kodus auth login."
                />
            </Shell>
        );
    }

    if (isLoading) {
        return (
            <Shell>
                <div className="flex flex-col items-center gap-3 py-6">
                    <Spinner className="size-7" />
                    <p className="text-text-tertiary text-sm">
                        Verifying request…
                    </p>
                </div>
            </Shell>
        );
    }

    if (isError || !info?.found) {
        return (
            <Shell>
                <ErrorBlock
                    title="Authorization request not found"
                    description="The link may have expired. Run kodus auth login again to start a new request."
                />
            </Shell>
        );
    }

    if (info.status && info.status !== "pending") {
        const errorTitle =
            info.status === "expired"
                ? "This authorization link has expired"
                : info.status === "consumed" || info.status === "completed"
                  ? "This request was already authorized"
                  : "This authorization link is no longer valid";
        return (
            <Shell>
                <ErrorBlock
                    title={errorTitle}
                    description="Run kodus auth login again from the CLI to start a new request."
                />
            </Shell>
        );
    }

    if (completedMode === "device") {
        return (
            <Shell>
                <SuccessBlock
                    title="Device authorized"
                    description="Your CLI is now authenticated. You can close this tab and return to the terminal."
                />
            </Shell>
        );
    }

    const handleAuthorize = async () => {
        setErrorMessage(null);
        try {
            const result = await completeMutation.mutateAsync({
                state,
                userCode,
            });

            if (result.mode === "loopback" && result.redirectUri) {
                // Loopback: redirect the browser to the CLI's local server with
                // only the state. The CLI then fetches the JWT via
                // GET /cli/auth/login-poll over HTTPS — token never lands in
                // the browser URL or referer.
                const url = new URL(result.redirectUri);
                url.searchParams.set("state", result.state);
                window.location.replace(url.toString());
                return;
            }

            setCompletedMode(result.mode);
        } catch (err) {
            setErrorMessage(
                err instanceof Error
                    ? err.message
                    : "Failed to authorize the CLI. Try again.",
            );
        }
    };

    return (
        <Shell>
            <div className="flex flex-col items-center gap-3 text-center">
                <div className="bg-primary-light/10 text-primary-light flex size-12 items-center justify-center rounded-full">
                    <TerminalIcon aria-hidden className="size-6" />
                </div>
                <Heading variant="h2" className="text-balance">
                    Authorize Kodus CLI
                </Heading>
                <p className="text-text-secondary text-pretty text-sm">
                    A device is requesting access to your Kodus account.
                </p>
            </div>

            <ul className="flex flex-col gap-2">
                <InfoRow
                    icon={<LaptopIcon aria-hidden />}
                    label="Device"
                    value={info.userAgent ?? "Unknown"}
                />
                <InfoRow
                    icon={<ShieldCheckIcon aria-hidden />}
                    label="Mode"
                    value={
                        info.mode === "device"
                            ? "Device code"
                            : "Browser (loopback)"
                    }
                />
                {expiresInLabel && (
                    <InfoRow
                        icon={<TimerIcon aria-hidden />}
                        label="Expires"
                        value={expiresInLabel}
                    />
                )}
            </ul>

            {errorMessage && (
                <div
                    role="alert"
                    className="bg-danger/10 text-danger flex items-start gap-2 rounded-lg p-3 text-sm">
                    <AlertTriangleIcon
                        aria-hidden
                        className="mt-0.5 size-4 shrink-0"
                    />
                    <span className="text-pretty">{errorMessage}</span>
                </div>
            )}

            <div className="flex flex-col items-stretch gap-2">
                <Button
                    variant="primary"
                    size="md"
                    onClick={handleAuthorize}
                    loading={completeMutation.isPending}
                    className="w-full justify-center">
                    Authorize CLI
                </Button>
                <NextLink href="/" className="self-center">
                    <Button variant="cancel" size="sm">
                        Cancel
                    </Button>
                </NextLink>
            </div>

            <p className="text-text-tertiary text-center text-xs text-balance">
                Only authorize if you just ran{" "}
                <code className="bg-card-lv2 text-text-secondary rounded px-1.5 py-0.5 font-mono text-[11px]">
                    kodus auth login
                </code>{" "}
                on a trusted device.
            </p>
        </Shell>
    );
}

function Shell({ children }: { children: React.ReactNode }) {
    return (
        <Page.Root className="flex h-full w-full flex-col items-center justify-center overflow-auto">
            <Card
                color="lv1"
                className="flex w-full max-w-md flex-col gap-6 p-8">
                <div className="flex justify-center">
                    <SvgKodus className="h-7" />
                </div>
                {children}
            </Card>
        </Page.Root>
    );
}

function InfoRow({
    icon,
    label,
    value,
}: {
    icon: React.ReactNode;
    label: string;
    value: string;
}) {
    return (
        <li className="bg-card-lv2 flex items-center justify-between gap-3 rounded-lg px-4 py-3">
            <span className="text-text-tertiary inline-flex items-center gap-2 text-xs [&>svg]:size-4">
                {icon}
                {label}
            </span>
            <span className="text-text-primary truncate text-sm">{value}</span>
        </li>
    );
}

function ErrorBlock({
    title,
    description,
}: {
    title: string;
    description: string;
}) {
    return (
        <div className="flex flex-col items-center gap-3 text-center">
            <div className="bg-danger/10 text-danger flex size-12 items-center justify-center rounded-full">
                <AlertTriangleIcon aria-hidden className="size-6" />
            </div>
            <Heading variant="h2" className="text-balance">
                {title}
            </Heading>
            <p className="text-text-secondary text-pretty text-sm">
                {description}
            </p>
            <NextLink href="/" className="mt-2">
                <Button variant="cancel" size="sm">
                    Back to dashboard
                </Button>
            </NextLink>
        </div>
    );
}

function SuccessBlock({
    title,
    description,
}: {
    title: string;
    description: string;
}) {
    return (
        <div className="flex flex-col items-center gap-3 text-center">
            <div className="bg-success/10 text-success flex size-12 items-center justify-center rounded-full">
                <CheckCircle2Icon aria-hidden className="size-6" />
            </div>
            <Heading variant="h2" className="text-balance">
                {title}
            </Heading>
            <p className="text-text-secondary text-pretty text-sm">
                {description}
            </p>
        </div>
    );
}

function formatExpiresIn(iso: string): string {
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return "Expired";
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `in ${seconds}s`;
    const minutes = Math.round(seconds / 60);
    return `in ${minutes} min`;
}
