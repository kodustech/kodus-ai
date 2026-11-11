"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@components/ui/button";
import { Card, CardContent, CardHeader } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { Link } from "@components/ui/link";
import { testBYOKModel } from "@services/organizationParameters/fetch";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { ChevronsUpDownIcon } from "lucide-react";
import { Controller, useFormContext, useWatch } from "react-hook-form";
import {
    useCodeReviewConfig,
    useCodeReviewModelData,
} from "src/app/(app)/settings/_components/context";
import { useCurrentConfigLevel } from "src/app/(app)/settings/_hooks";
import { OverrideIndicator } from "src/app/(app)/settings/code-review/_components/override";
import {
    indexRoutingModels,
    routingModelLabels,
} from "src/features/ee/byok/_components/routing/routing-state";
import { ModelCombobox } from "src/features/ee/byok/_components/routing/task-override-grid";
import { formatModelLabel } from "src/features/ee/byok/_data/model-label";

import { FormattedConfigLevel, type CodeReviewFormType } from "../../../_types";

/** Scope pins and connection probes retain the selected slot's provider identity. */
export const BYOKModelSelectorSection = ({
    disabled = false,
}: {
    disabled?: boolean;
}) => {
    const form = useFormContext<CodeReviewFormType>();
    const config = useCodeReviewConfig();
    const level = useCurrentConfigLevel();
    const { llmConfigStatus, hasConnectedProvider, isCheckingProvider } =
        useCodeReviewModelData();
    const canTest = usePermission(
        Action.Create,
        ResourceType.OrganizationSettings,
    );
    const canReadModels = usePermission(
        Action.Read,
        ResourceType.OrganizationSettings,
    );
    const request = useRef(0);
    type ProbeState = {
        state: "idle" | "testing" | "success" | "error";
        message?: string;
    };
    const [testResult, setTestResult] = useState<
        ProbeState & {
            identity?: string;
            status?: typeof llmConfigStatus;
            checking: boolean;
        }
    >({ state: "idle", checking: !!isCheckingProvider });
    if (testResult.checking !== !!isCheckingProvider) {
        setTestResult({ state: "idle", checking: !!isCheckingProvider });
    }
    const leaf = config?.byokModelId ?? config?.byokModel;
    const parentValue = ((leaf?.level === level
        ? leaf.overriddenValue
        : leaf?.value) ?? "") as string;
    // Legacy names must never be persisted as slot ids when restoring inheritance.
    const inheritValue = config?.byokModelId ? parentValue : "";
    const scope =
        level === FormattedConfigLevel.DIRECTORY
            ? "directory"
            : level === FormattedConfigLevel.GLOBAL
              ? "organization"
              : "repository";
    const models = (llmConfigStatus?.models ?? []).filter(
        (model) => !model.managed,
    );
    const modelFor = indexRoutingModels(models);
    const labels = routingModelLabels(models);
    const labelOf = (id: string) => {
        const model = modelFor(id);
        return model
            ? (labels.get(model.modelId) ??
                  formatModelLabel(model.model ?? model.modelId))
            : id;
    };
    const selectedId =
        useWatch({ control: form.control, name: "byokModelId.value" }) ??
        config?.byokModelId?.value ??
        config?.byokModel?.value ??
        "";
    const selected = modelFor(selectedId);
    const identity = JSON.stringify([
        selectedId,
        selected?.providerId,
        selected?.credentialId,
        selected?.model,
        selected?.baseUrl,
    ]);
    const test: ProbeState =
        testResult.identity === identity &&
        testResult.status === llmConfigStatus &&
        !isCheckingProvider
            ? testResult
            : { state: "idle" };
    const setTest = (value: ProbeState) =>
        setTestResult({
            ...value,
            identity,
            status: llmConfigStatus,
            checking: !!isCheckingProvider,
        });
    useEffect(() => {
        ++request.current;
        return () => {
            ++request.current;
        };
    }, [identity, isCheckingProvider]);
    if (!hasConnectedProvider) return null;

    const probe = async (id: string) => {
        const model = modelFor(id);
        if (!canTest || !model?.providerId) return;
        const current = ++request.current;
        setTest({ state: "testing" });
        try {
            const result = await testBYOKModel({
                provider: model.providerId,
                model: model.model ?? model.modelId,
                ...(model.credentialId
                    ? { credentialId: model.credentialId }
                    : {}),
            });
            if (request.current !== current) return;
            setTest(
                result.ok
                    ? {
                          state: "success",
                          message:
                              result.verifiedBy === "probe"
                                  ? "Connection verified"
                                  : "Model available",
                      }
                    : {
                          state: "error",
                          message:
                              result.providerMessage ||
                              result.message ||
                              "Model test failed.",
                      },
            );
        } catch {
            if (request.current === current)
                setTest({
                    state: "error",
                    message: "Could not test this model. Try again.",
                });
        }
    };
    return (
        <Controller
            name="byokModelId.value"
            control={form.control}
            defaultValue={
                config?.byokModelId?.value ?? config?.byokModel?.value ?? ""
            }
            render={({ field }) => {
                const value = field.value ?? "";
                const inherited =
                    value === inheritValue ||
                    (!config?.byokModelId &&
                        leaf?.level !== level &&
                        value === leaf?.value);
                const unknown = !!value && !modelFor(value);
                const unavailable =
                    !!value && modelFor(value)?.resolvable === false;
                const blocked =
                    disabled || !!field.disabled || !!isCheckingProvider;
                const select = (id: string) => {
                    if (blocked) return;
                    ++request.current;
                    setTest({ state: "idle" });
                    field.onChange(id);
                };
                return (
                    <Card color="lv1">
                        <CardHeader>
                            <div className="flex flex-wrap items-center gap-2">
                                <Heading variant="h3">
                                    Code review model override
                                </Heading>
                                <OverrideIndicator
                                    currentValue={value}
                                    initialState={
                                        leaf ?? {
                                            value: "",
                                            level: FormattedConfigLevel.DEFAULT,
                                        }
                                    }
                                    handleRevert={
                                        blocked
                                            ? undefined
                                            : () => select(inheritValue)
                                    }
                                />
                            </div>
                            <p className="text-text-secondary text-sm">
                                {inherited
                                    ? parentValue
                                        ? "Uses the inherited model override."
                                        : "Uses the routing models."
                                    : `Uses one model for Balanced and Heavy in this ${scope}.`}
                            </p>
                        </CardHeader>
                        <CardContent>
                            <ModelCombobox
                                models={models.map((model) => ({
                                    id: model.modelId,
                                    label: labelOf(model.modelId),
                                    provider: model.providerId,
                                    capabilities: model.capabilities,
                                    disabled: !model.resolvable,
                                    disabledReason:
                                        "Reconnect this provider before using its model.",
                                }))}
                                value={value}
                                gateTask="codeReview"
                                disabled={blocked}
                                onSelect={select}
                                defaultOption={{
                                    label: parentValue
                                        ? `Use inherited model · ${labelOf(parentValue)}`
                                        : "Use routing models",
                                    selected: inherited,
                                    onSelect: () => select(inheritValue),
                                }}
                                trigger={
                                    <Button
                                        type="button"
                                        size="md"
                                        variant="helper"
                                        role="combobox"
                                        aria-label="Code review model override"
                                        id={field.name}
                                        disabled={blocked}
                                        className="w-full justify-between sm:max-w-96"
                                        rightIcon={
                                            <ChevronsUpDownIcon className="opacity-50" />
                                        }>
                                        <span className="truncate">
                                            {inherited
                                                ? parentValue
                                                    ? `Inherited · ${labelOf(parentValue)}`
                                                    : "Use routing models"
                                                : unknown || unavailable
                                                  ? "Unavailable model"
                                                  : labelOf(value)}
                                        </span>
                                    </Button>
                                }
                            />
                            {(unknown || unavailable) && (
                                <div
                                    role="note"
                                    className="text-warning mt-3 flex flex-wrap items-center gap-3 text-sm">
                                    <p>
                                        {unavailable
                                            ? "Reconnect this model’s provider or choose another model."
                                            : "This model isn’t in the connected list."}
                                    </p>
                                    {!inherited && (
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="helper"
                                            disabled={blocked}
                                            onClick={() =>
                                                select(inheritValue)
                                            }>
                                            Reset to inherit
                                        </Button>
                                    )}
                                </div>
                            )}
                            {!!value && !unknown && !unavailable && canTest && (
                                <div className="mt-3 flex flex-wrap items-center gap-3">
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="helper"
                                        disabled={
                                            blocked ||
                                            test.state === "testing" ||
                                            !modelFor(value)?.providerId
                                        }
                                        loading={test.state === "testing"}
                                        onClick={() => probe(value)}>
                                        Test model
                                    </Button>
                                    {test.state === "success" && (
                                        <span
                                            role="status"
                                            className="text-success text-sm">
                                            {test.message}
                                        </span>
                                    )}
                                    {test.state === "error" && (
                                        <span
                                            role="alert"
                                            className="text-danger text-sm">
                                            {test.message}
                                        </span>
                                    )}
                                </div>
                            )}
                            {canReadModels && (
                                <Link
                                    href="/byok"
                                    className="mt-3 block text-sm">
                                    Manage AI providers ↗
                                </Link>
                            )}
                        </CardContent>
                    </Card>
                );
            }}
        />
    );
};
