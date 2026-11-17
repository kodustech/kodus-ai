"use client";

import { Button } from "@components/ui/button";
import { Card, CardContent, CardHeader } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { Link } from "@components/ui/link";
import { Spinner } from "@components/ui/spinner";
import { ChevronsUpDownIcon } from "lucide-react";
import { ProviderAvatar } from "src/features/ee/byok/_components/provider-avatar";
import {
    ModelCombobox,
    TaskModelControl,
    TaskOverrideGrid,
} from "src/features/ee/byok/_components/routing/task-override-grid";
import type { LlmTask } from "src/features/ee/byok/_types";

import type { OrganizationRoutingController } from "./use-organization-routing";

const reviewTasks: {
    task: "riskAssessment" | "codeReview" | "codeReviewHeavy";
    label: string;
}[] = [
    { task: "riskAssessment", label: "Risk assessment model" },
    { task: "codeReview", label: "Balanced model" },
    { task: "codeReviewHeavy", label: "Heavy model" },
];
const otherTasks: LlmTask[] = [
    "kodyRulesReview",
    "prSummary",
    "conversation",
    "businessValidation",
    "customAgent",
];

export function OrganizationModels({
    controller,
    heavyAllowed,
    canEdit,
}: {
    controller: OrganizationRoutingController;
    heavyAllowed: boolean;
    canEdit: boolean;
}) {
    const { pool, routing } = controller;
    const single = pool.length === 1;
    const editable = canEdit && controller.canEdit;
    const defaultModel = pool.find(
        (model) => model.id === routing.defaultModelId,
    );
    const fallbackModel = pool.find(
        (model) => model.id === routing.fallbackModelId,
    );
    return (
        <>
            <Card color="lv1">
                <CardHeader className="flex-row flex-wrap items-start justify-between gap-4">
                    <div className="flex flex-col gap-1">
                        <Heading variant="h3">Models</Heading>
                        <p className="text-text-secondary text-sm">
                            Defaults for your organization.
                        </p>
                    </div>
                    <Link href="/byok" className="text-sm">
                        Manage AI providers ↗
                    </Link>
                </CardHeader>
                <CardContent>
                    {controller.loading ? (
                        <Spinner />
                    ) : controller.error ? (
                        <div
                            role="alert"
                            className="flex flex-wrap items-center gap-3 text-sm">
                            <p>Could not load organization models.</p>
                            <Button
                                type="button"
                                size="sm"
                                variant="helper"
                                onClick={() => controller.refetch()}>
                                Retry
                            </Button>
                        </div>
                    ) : (
                        <>
                            <div className="divide-card-lv3 divide-y text-sm">
                                <div
                                    data-routing-anchor="default"
                                    className="grid items-start gap-3 py-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
                                    <span className="pt-2.5">
                                        Default model
                                    </span>
                                    <ModelCombobox
                                        models={pool}
                                        value={routing.defaultModelId}
                                        disabled={
                                            !editable ||
                                            (single && !!defaultModel)
                                        }
                                        onSelect={controller.setDefault}
                                        trigger={
                                            <Button
                                                type="button"
                                                size="md"
                                                variant="helper"
                                                role="combobox"
                                                aria-label="Default model"
                                                disabled={
                                                    !editable ||
                                                    (single && !!defaultModel)
                                                }
                                                className="w-full justify-between sm:max-w-80"
                                                rightIcon={
                                                    <ChevronsUpDownIcon className="opacity-50" />
                                                }>
                                                <span className="flex min-w-0 items-center gap-2">
                                                    <ProviderAvatar
                                                        provider={
                                                            defaultModel?.provider
                                                        }
                                                    />
                                                    <span className="truncate">
                                                        {defaultModel?.label ??
                                                            "Select a connected model"}
                                                    </span>
                                                </span>
                                            </Button>
                                        }
                                    />
                                </div>
                                <div
                                    data-routing-anchor="fallback"
                                    className="grid items-start gap-3 py-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
                                    <div>
                                        <p className="pt-2.5">Fallback model</p>
                                        <p className="text-text-secondary mt-1 text-xs">
                                            Used when a model fails.
                                        </p>
                                    </div>
                                    <ModelCombobox
                                        models={pool.filter(
                                            (model) =>
                                                model.id !==
                                                routing.defaultModelId,
                                        )}
                                        value={routing.fallbackModelId}
                                        disabled={
                                            !editable ||
                                            (single && !routing.fallbackModelId)
                                        }
                                        onSelect={controller.setFallback}
                                        defaultOption={{
                                            label: "None",
                                            selected: !routing.fallbackModelId,
                                            onSelect: () =>
                                                controller.setFallback(
                                                    undefined,
                                                ),
                                        }}
                                        trigger={
                                            <Button
                                                type="button"
                                                size="md"
                                                variant="helper"
                                                role="combobox"
                                                aria-label="Fallback model"
                                                disabled={
                                                    !editable ||
                                                    (single &&
                                                        !routing.fallbackModelId)
                                                }
                                                className="w-full justify-between sm:max-w-80"
                                                rightIcon={
                                                    <ChevronsUpDownIcon className="opacity-50" />
                                                }>
                                                <span className="flex min-w-0 items-center gap-2">
                                                    <ProviderAvatar
                                                        provider={
                                                            fallbackModel?.provider
                                                        }
                                                    />
                                                    <span className="truncate">
                                                        {fallbackModel?.label ??
                                                            (routing.fallbackModelId
                                                                ? "Unavailable model"
                                                                : "None")}
                                                    </span>
                                                </span>
                                            </Button>
                                        }
                                    />
                                </div>
                                {reviewTasks.map(({ task, label }) => (
                                    <div
                                        key={task}
                                        data-routing-anchor={`task:${task}`}
                                        className="grid items-start gap-3 py-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
                                        <span className="pt-2.5">{label}</span>
                                        {task === "codeReviewHeavy" &&
                                        !heavyAllowed ? (
                                            <p className="text-text-secondary py-2.5">
                                                Available on Teams and
                                                Enterprise.
                                            </p>
                                        ) : (
                                            <div className="min-w-0 sm:max-w-80">
                                                <TaskModelControl
                                                    task={task}
                                                    label={label}
                                                    models={pool}
                                                    defaultModelId={
                                                        routing.defaultModelId
                                                    }
                                                    taskOverrides={
                                                        routing.taskOverrides ??
                                                        {}
                                                    }
                                                    onChange={
                                                        controller.setTask
                                                    }
                                                    disabled={
                                                        !editable ||
                                                        (single &&
                                                            !routing
                                                                .taskOverrides?.[
                                                                task
                                                            ])
                                                    }
                                                />
                                                {controller.effectiveModel(task)
                                                    .modelId !==
                                                    (routing.taskOverrides?.[
                                                        task
                                                    ] ??
                                                        routing.defaultModelId) && (
                                                    <p className="text-text-secondary mt-2 text-xs">
                                                        Uses{" "}
                                                        {
                                                            controller.effectiveModel(
                                                                task,
                                                            ).label
                                                        }
                                                    </p>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                            {single && (
                                <p className="text-text-secondary mt-3 text-sm">
                                    One connected model. Add another in AI
                                    providers to use separate models.
                                </p>
                            )}
                            {!canEdit && (
                                <p className="text-text-secondary mt-3 text-sm">
                                    Organization permission is required to edit
                                    models.
                                </p>
                            )}
                            {controller.validationError && (
                                <p
                                    role="alert"
                                    className="text-danger mt-3 text-sm">
                                    {controller.validationError}
                                </p>
                            )}
                        </>
                    )}
                </CardContent>
            </Card>
        </>
    );
}

export function OtherTaskModels({
    controller,
    heavyAllowed,
    canEdit,
}: {
    controller: OrganizationRoutingController;
    heavyAllowed: boolean;
    canEdit: boolean;
}) {
    const { pool, routing } = controller;
    const single = pool.length === 1;
    const editable = canEdit && controller.canEdit;
    return (
        <>
            {controller.ready && (
                <Card color="lv1">
                    <details className="group">
                        <summary className="cursor-pointer p-6 text-sm font-semibold">
                            Other task models
                        </summary>
                        <CardContent>
                            <TaskOverrideGrid
                                tasks={otherTasks}
                                models={pool}
                                defaultModelId={routing.defaultModelId}
                                taskOverrides={routing.taskOverrides ?? {}}
                                onChange={controller.setTask}
                                heavyPlanAllowed={heavyAllowed}
                                disabled={
                                    !editable ||
                                    (single &&
                                        !otherTasks.some(
                                            (task) =>
                                                routing.taskOverrides?.[task],
                                        ))
                                }
                            />
                        </CardContent>
                    </details>
                </Card>
            )}
        </>
    );
}
