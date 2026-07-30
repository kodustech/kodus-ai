"use client";

import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { Card, CardContent, CardHeader } from "@components/ui/card";
import { Label } from "@components/ui/label";
import { Page } from "@components/ui/page";
import { Separator } from "@components/ui/separator";
import { Switch } from "@components/ui/switch";
import { toast } from "@components/ui/toaster/use-toast";
import { zodResolver } from "@hookform/resolvers/zod";
import { useAsyncAction } from "@hooks/use-async-action";
import { updateCockpitMetricsVisibility } from "@services/organizationParameters/fetch";
import { CockpitMetricsVisibility } from "@services/parameters/types";
import { Save } from "lucide-react";
import {
    Control,
    Controller,
    FieldPath,
    useForm,
    useWatch,
} from "react-hook-form";
import { revalidateServerSidePath } from "src/core/utils/revalidate-server-side";
import { cn } from "src/core/utils/components";
import { z } from "zod";

const createSettingsSchema = () =>
    z.object({
        cockpitMetricsVisibility: z.object({
            tabs: z
                .object({
                    kodusReview: z.boolean(),
                    productivity: z.boolean(),
                })
                .refine((t) => t.kodusReview || t.productivity, {
                    message: "At least one tab must stay enabled",
                    path: ["productivity"],
                }),
            summary: z.object({
                deployFrequency: z.boolean(),
                prCycleTime: z.boolean(),
                kodySuggestions: z.boolean(),
                bugRatio: z.boolean(),
                prSize: z.boolean(),
            }),
            details: z.object({
                leadTimeBreakdown: z.boolean(),
                prCycleTime: z.boolean(),
                prsOpenedVsClosed: z.boolean(),
                prsMergedByDeveloper: z.boolean(),
                teamActivity: z.boolean(),
            }),
        }),
    });

type SettingsFormData = z.infer<ReturnType<typeof createSettingsSchema>>;
type FieldName = FieldPath<SettingsFormData>;

type MetricRow = { name: FieldName; label: string; description: string };

const SUMMARY_METRICS: MetricRow[] = [
    {
        name: "cockpitMetricsVisibility.summary.deployFrequency",
        label: "Deploy Frequency",
        description: "How often your team deploys to production",
    },
    {
        name: "cockpitMetricsVisibility.summary.prCycleTime",
        label: "PR Cycle Time",
        description: "Average time from PR creation to merge",
    },
    {
        name: "cockpitMetricsVisibility.summary.bugRatio",
        label: "Bug Ratio",
        description: "Percentage of bugs in your codebase",
    },
    {
        name: "cockpitMetricsVisibility.summary.prSize",
        label: "PR Size",
        description: "Average size of pull requests",
    },
];

const DETAIL_METRICS: MetricRow[] = [
    {
        name: "cockpitMetricsVisibility.details.leadTimeBreakdown",
        label: "Lead Time Breakdown",
        description: "Detailed breakdown of lead time stages",
    },
    {
        name: "cockpitMetricsVisibility.details.prCycleTime",
        label: "PR Cycle Time Chart",
        description: "Detailed PR cycle time over time",
    },
    {
        name: "cockpitMetricsVisibility.details.prsOpenedVsClosed",
        label: "PRs Opened vs Closed",
        description: "Comparison of opened and closed pull requests",
    },
    {
        name: "cockpitMetricsVisibility.details.prsMergedByDeveloper",
        label: "PRs Merged by Developer",
        description: "Number of PRs merged per team member",
    },
    {
        name: "cockpitMetricsVisibility.details.teamActivity",
        label: "Team Activity",
        description: "Overall team activity and contributions",
    },
];

const MetricToggle = ({
    control,
    row,
}: {
    control: Control<SettingsFormData>;
    row: MetricRow;
}) => (
    <Controller
        name={row.name}
        control={control}
        render={({ field }) => (
            <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-0.5">
                    <Label
                        htmlFor={field.name}
                        className="text-sm font-medium">
                        {row.label}
                    </Label>
                    <p className="text-text-tertiary text-xs">
                        {row.description}
                    </p>
                </div>
                <Switch
                    id={field.name}
                    checked={field.value as boolean}
                    onCheckedChange={field.onChange}
                />
            </div>
        )}
    />
);

const TabToggle = ({
    control,
    name,
    title,
    description,
}: {
    control: Control<SettingsFormData>;
    name: FieldName;
    title: string;
    description: string;
}) => (
    <Controller
        name={name}
        control={control}
        render={({ field }) => (
            <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-1">
                    <Label
                        htmlFor={field.name}
                        className="text-base font-bold">
                        {title}
                    </Label>
                    <p className="text-text-secondary text-sm">
                        {description}
                    </p>
                </div>
                <Switch
                    id={field.name}
                    checked={field.value as boolean}
                    onCheckedChange={field.onChange}
                />
            </div>
        )}
    />
);

export const CockpitOrganizationSettingsPage = (props: {
    cockpitMetricsVisibility: CockpitMetricsVisibility;
}) => {
    const router = useRouter();

    const form = useForm<SettingsFormData>({
        mode: "onChange",
        resolver: zodResolver(createSettingsSchema()),
        defaultValues: {
            cockpitMetricsVisibility: props.cockpitMetricsVisibility,
        },
    });

    const {
        control,
        handleSubmit,
        formState: { isDirty, isValid },
    } = form;

    // Summary/Detail metrics all live inside the Productivity tab — no point
    // configuring them while that tab is hidden.
    const productivityEnabled = useWatch({
        control,
        name: "cockpitMetricsVisibility.tabs.productivity",
    });

    const [saveSettings, { loading: isLoadingSubmitButton }] = useAsyncAction(
        async (data: SettingsFormData) => {
            try {
                await updateCockpitMetricsVisibility({
                    config: data.cockpitMetricsVisibility,
                });

                await revalidateServerSidePath("/organization/cockpit");
                router.refresh();

                toast({ description: "Settings saved", variant: "success" });
            } catch (error: any) {
                toast({
                    title: "Error",
                    description: error.message,
                    variant: "danger",
                });
                console.error(error);
            }
        },
    );

    return (
        <Page.Root>
            <form onSubmit={handleSubmit(saveSettings)}>
                <Page.Header>
                    <Page.Title>Cockpit Configuration</Page.Title>
                    <Page.HeaderActions>
                        <Button
                            type="submit"
                            size="md"
                            variant="primary"
                            leftIcon={<Save />}
                            disabled={
                                !isDirty || !isValid || isLoadingSubmitButton
                            }
                            loading={isLoadingSubmitButton}>
                            Save settings
                        </Button>
                    </Page.HeaderActions>
                </Page.Header>

                <Page.Content>
                    <div className="flex w-full max-w-3xl flex-col gap-4">
                        <p className="text-text-secondary text-sm">
                            Show or hide cockpit tabs and the metrics inside
                            them. At least one tab must stay enabled.
                        </p>

                        {/* Kodus Review tab — no per-metric configuration */}
                        <Card color="lv1" className="w-full">
                            <CardHeader>
                                <TabToggle
                                    control={control}
                                    name="cockpitMetricsVisibility.tabs.kodusReview"
                                    title="Kodus Review"
                                    description="Implementation rate, severity calibration, negative feedback and Kody Rule health."
                                />
                            </CardHeader>
                        </Card>

                        {/* Productivity tab — owns the Summary & Detail metrics */}
                        <Card color="lv1" className="w-full">
                            <CardHeader>
                                <TabToggle
                                    control={control}
                                    name="cockpitMetricsVisibility.tabs.productivity"
                                    title="Productivity"
                                    description="Delivery metrics: deploy frequency, lead time, PR size and developer activity."
                                />
                            </CardHeader>

                            <CardContent
                                className={cn(
                                    "flex flex-col gap-6 transition-opacity",
                                    !productivityEnabled &&
                                        "pointer-events-none opacity-40 select-none",
                                )}
                                aria-disabled={!productivityEnabled}>
                                <Separator />

                                <div className="flex flex-col gap-4">
                                    <div className="flex flex-col gap-0.5">
                                        <span className="text-text-secondary text-xs font-bold tracking-wide uppercase">
                                            Summary cards
                                        </span>
                                        <span className="text-text-tertiary text-xs">
                                            Shown at the top of the
                                            Productivity tab
                                        </span>
                                    </div>
                                    <div className="flex flex-col gap-3">
                                        {SUMMARY_METRICS.map((row) => (
                                            <MetricToggle
                                                key={row.name}
                                                control={control}
                                                row={row}
                                            />
                                        ))}
                                    </div>
                                </div>

                                <Separator />

                                <div className="flex flex-col gap-4">
                                    <div className="flex flex-col gap-0.5">
                                        <span className="text-text-secondary text-xs font-bold tracking-wide uppercase">
                                            Detail charts
                                        </span>
                                        <span className="text-text-tertiary text-xs">
                                            The detailed charts section
                                        </span>
                                    </div>
                                    <div className="flex flex-col gap-3">
                                        {DETAIL_METRICS.map((row) => (
                                            <MetricToggle
                                                key={row.name}
                                                control={control}
                                                row={row}
                                            />
                                        ))}
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    </div>
                </Page.Content>
            </form>
        </Page.Root>
    );
};
