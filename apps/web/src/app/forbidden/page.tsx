"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@components/ui/button";
import { Card } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { SvgKodus } from "@components/ui/icons/SvgKodus";
import { Page } from "@components/ui/page";
import { ArrowLeft, LockIcon } from "lucide-react";

// Friendly names for the gated URL prefixes in permissions.routes.ts.
const AREA_LABELS: Array<{ prefix: string; label: string }> = [
    { prefix: "/settings/subscription", label: "Billing & Subscription" },
    { prefix: "/settings/git", label: "Git settings" },
    { prefix: "/settings/integrations", label: "Git settings" },
    { prefix: "/settings/plugins", label: "Plugins" },
    { prefix: "/settings/code-review", label: "Code Review settings" },
    { prefix: "/choose-plan", label: "Billing & Subscription" },
    { prefix: "/cockpit", label: "the Cockpit" },
    { prefix: "/review-suggestions", label: "the Cockpit" },
    { prefix: "/issues", label: "Issues" },
    { prefix: "/pull-requests", label: "Pull Requests" },
    { prefix: "/cli-reviews", label: "CLI Reviews" },
    { prefix: "/organization", label: "Organization settings" },
    { prefix: "/user-logs", label: "Audit logs" },
    { prefix: "/token-usage", label: "Token usage" },
];

const ForbiddenCard = () => {
    const from = useSearchParams().get("from");
    const area = from
        ? AREA_LABELS.find(({ prefix }) => from.startsWith(prefix))?.label
        : undefined;

    return (
        <Card
            color="lv1"
            className="flex w-md flex-col items-center justify-center gap-10 p-10">
            <Page.Header className="flex w-full flex-col items-center gap-8">
                <SvgKodus className="h-8" />

                <div className="flex flex-col items-center gap-4">
                    <div className="bg-card-lv2 flex size-12 items-center justify-center rounded-full">
                        <LockIcon className="text-primary-light size-5" />
                    </div>

                    <div className="flex flex-col items-center gap-2">
                        <Heading variant="h2" className="text-center">
                            {area
                                ? `You don't have access to ${area}`
                                : "Access Denied"}
                        </Heading>

                        <div className="text-text-secondary text-center text-sm">
                            <p>
                                Your role doesn't include this area. Ask an
                                organization admin to grant you access.
                            </p>
                        </div>
                    </div>
                </div>
            </Page.Header>

            <div className="flex gap-4">
                <Button
                    size="sm"
                    variant="cancel"
                    leftIcon={<ArrowLeft />}
                    onClick={() => window.history.back()}>
                    Go back
                </Button>

                <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                        window.location.href = "/";
                    }}>
                    Go to start page
                </Button>
            </div>
        </Card>
    );
};

export default function GlobalForbidden() {
    return (
        <Page.Root className="flex h-full w-full flex-col items-center justify-center overflow-auto">
            <Suspense fallback={null}>
                <ForbiddenCard />
            </Suspense>
        </Page.Root>
    );
}
