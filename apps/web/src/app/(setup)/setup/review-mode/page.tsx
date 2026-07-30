"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertTitle } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import { Heading } from "@components/ui/heading";
import { Page } from "@components/ui/page";
import { SliderWithMarkers } from "@components/ui/slider-with-markers";
import { toast } from "@components/ui/toaster/use-toast";
import { createOrUpdateCodeReviewParameter } from "@services/parameters/fetch";
import { AlertCircleIcon } from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import type { CodeReviewGlobalConfig } from "src/app/(app)/settings/code-review/_types";
import { SeverityLevel } from "src/core/types";
import { cn } from "src/core/utils/components";

import { StepIndicators } from "../_components/step-indicators";

const SEVERITY_ORDER: SeverityLevel[] = [
    SeverityLevel.LOW,
    SeverityLevel.MEDIUM,
    SeverityLevel.HIGH,
    SeverityLevel.CRITICAL,
];

const SEVERITY_LABELS: Record<SeverityLevel, string> = {
    [SeverityLevel.LOW]: "Low/All",
    [SeverityLevel.MEDIUM]: "Medium",
    [SeverityLevel.HIGH]: "High",
    [SeverityLevel.CRITICAL]: "Critical",
};

export default function ReviewSetupPage() {
    const router = useRouter();
    const { teamId } = useSelectedTeamId();
    const [isSaving, setIsSaving] = useState(false);
    const [severity, setSeverity] = useState<SeverityLevel>(
        SeverityLevel.MEDIUM,
    );

    const severityIndex = SEVERITY_ORDER.indexOf(severity);

    const handleContinue = async () => {
        if (!teamId) {
            toast({
                variant: "danger",
                description: "Missing team. Please try again.",
            });
            return;
        }

        const configValue: Partial<CodeReviewGlobalConfig> = {
            suggestionControl: {
                severityLevelFilter: severity,
            } as CodeReviewGlobalConfig["suggestionControl"],
        };

        try {
            setIsSaving(true);
            const result = await createOrUpdateCodeReviewParameter(
                configValue,
                teamId,
                "global",
            );

            if (result?.error) {
                throw new Error(String(result.error));
            }

            router.push("/setup/customize-team");
        } catch (error) {
            console.error("Error saving review setup", error);
            toast({
                variant: "danger",
                description:
                    "We couldn't save your review settings. Please try again.",
            });
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <Page.Root className="mx-auto flex min-h-full w-full flex-col gap-6 p-6 lg:flex-row lg:gap-6">
            <div className="bg-card-lv1 flex w-full flex-col justify-center gap-10 rounded-3xl p-8 lg:max-w-none lg:flex-10 lg:p-12">
                <div className="flex-1 space-y-4 overflow-hidden">
                    <h1 className="text-2xl font-bold">
                        Set up your first review
                    </h1>
                    <p className="text-text-secondary text-md">
                        Choose the minimum severity worth commenting on. This
                        becomes your team default.
                    </p>
                    <Alert>
                        <AlertCircleIcon size={24} />
                        <AlertTitle>
                            <span className="text-text-secondary text-sm">
                                Don&apos;t worry, you can change this anytime in
                                Settings.
                            </span>
                        </AlertTitle>
                    </Alert>
                </div>
            </div>

            <div className="flex w-full flex-col gap-10 lg:flex-14 lg:p-10">
                <div className="flex flex-1 flex-col gap-8">
                    <StepIndicators.Auto />

                    <div className="flex flex-col gap-4">
                        <Heading variant="h2">Minimum severity level</Heading>
                        <span className="text-text-secondary text-sm">
                            Kody will only post suggestions from this severity
                            and higher.
                        </span>

                        <div className="w-full max-w-md">
                            <SliderWithMarkers
                                min={0}
                                max={SEVERITY_ORDER.length - 1}
                                step={1}
                                labels={SEVERITY_ORDER.map(
                                    (level) => SEVERITY_LABELS[level],
                                )}
                                value={severityIndex}
                                onValueChange={(value) =>
                                    setSeverity(SEVERITY_ORDER[value])
                                }
                                className={cn({
                                    "[--slider-marker-background-active:var(--color-info)]":
                                        severity === SeverityLevel.LOW,
                                    "[--slider-marker-background-active:var(--color-alert)]":
                                        severity === SeverityLevel.MEDIUM,
                                    "[--slider-marker-background-active:var(--color-warning)]":
                                        severity === SeverityLevel.HIGH,
                                    "[--slider-marker-background-active:var(--color-danger)]":
                                        severity === SeverityLevel.CRITICAL,
                                })}
                            />
                            <p className="text-text-secondary text-sm">
                                Suggestions from{" "}
                                <strong>{SEVERITY_LABELS[severity]}</strong> and
                                higher.
                            </p>
                        </div>
                    </div>

                    <div className="flex flex-col items-center gap-4">
                        <Button
                            size="lg"
                            variant="primary"
                            className="w-full"
                            onClick={handleContinue}
                            loading={isSaving}
                            disabled={isSaving}>
                            Continue
                        </Button>
                    </div>
                </div>
            </div>
        </Page.Root>
    );
}
