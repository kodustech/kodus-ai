"use client";

import { useFormContext, useWatch } from "react-hook-form";
import {
    useCodeReviewConfig,
    useCodeReviewModelData,
} from "src/app/(app)/settings/_components/context";
import {
    draftTaskModel,
    indexRoutingModels,
    routingModelLabels,
} from "src/features/ee/byok/_components/routing/routing-state";
import { formatModelLabel } from "src/features/ee/byok/_data/model-label";
import type { BYOKRouting } from "src/features/ee/byok/_types";
import { isHeavyModePlan } from "src/features/ee/heavy-mode/plan";
import { useSubscriptionContext } from "src/features/ee/subscription/_providers/subscription-context";
import {
    isUltraReviewPlan,
    isUltraTrioSet,
} from "src/features/ee/ultra-review/plan";

import type { CodeReviewFormType } from "../../../_types";

export type Mode = "balanced" | "heavy" | "ultra";
export const modeLabel = (mode: Mode) =>
    mode === "ultra" ? "Ultra" : mode === "heavy" ? "Heavy" : "Balanced";

/** The same effective plan fallback and scope override the review uses. */
export function useReviewRouting(modelDraft?: BYOKRouting) {
    const { control, getFieldState } = useFormContext<CodeReviewFormType>();
    const config = useCodeReviewConfig();
    const { llmConfigStatus: status, hasConnectedProvider } =
        useCodeReviewModelData();
    const license = useSubscriptionContext().license;
    const heavyAllowed = isHeavyModePlan(license);
    const ultraAllowed = isUltraReviewPlan(license);
    // The trio being edited on this page, else the one saved.
    const ultraModelIds =
        modelDraft?.ultraModelIds ?? status?.modelRouting?.ultraModelIds;
    const ultraSet = isUltraTrioSet(ultraModelIds);
    const active =
        useWatch({ control, name: "riskAssessmentActive.value" }) ??
        config?.riskAssessmentActive?.value ??
        false;
    const configuredDefault =
        useWatch({ control, name: "reviewMode.value" }) ??
        config?.reviewMode?.value ??
        "balanced";
    const noRisk =
        useWatch({ control, name: "riskReviewRouting.noRisk.value" }) ??
        config?.riskReviewRouting?.noRisk?.value ??
        "balanced";
    const riskFound =
        useWatch({ control, name: "riskReviewRouting.riskFound.value" }) ??
        config?.riskReviewRouting?.riskFound?.value ??
        "heavy";
    const selectedScope = useWatch({ control, name: "byokModelId.value" });
    const scopeModel =
        selectedScope !== undefined
            ? selectedScope
            : (config?.byokModelId?.value ?? config?.byokModel?.value);
    const modelForId = indexRoutingModels(status?.models ?? []);
    const labels = routingModelLabels(status?.models ?? []);
    const labelOf = (id?: string) => {
        const model = modelForId(id);
        const name =
            model?.model ?? id ?? status?.byok.model ?? status?.env.model;
        if (model)
            return (
                labels.get(model.modelId) ??
                formatModelLabel(name ?? model.modelId)
            );
        return name ? formatModelLabel(name) : "Kodus default";
    };
    // Ultra refused at review time runs no review, so it reads as Ultra and
    // the row says why (page.tsx); heavy refused runs Balanced.
    const effectiveMode = (mode: string): Mode =>
        mode === "ultra"
            ? "ultra"
            : mode === "heavy" && heavyAllowed
              ? "heavy"
              : "balanced";
    const modelFor = (mode: Mode) => {
        if (mode === "ultra") {
            return ultraSet
                ? `Uses ${ultraModelIds!.map((id) => labelOf(id)).join(", ")}.`
                : "Set up three Ultra models under Models.";
        }
        if (modelDraft && status) {
            const id = draftTaskModel(
                mode === "heavy" ? "codeReviewHeavy" : "codeReview",
                modelDraft,
                status,
                scopeModel,
            );
            return id
                ? labelOf(id)
                : status.env.model
                  ? formatModelLabel(status.env.model)
                  : "Kodus default";
        }
        const pin = status?.models.find(
            (model) => model.modelId === scopeModel,
        );
        const resolvedPin =
            pin && status?.reviewModelsByOverride?.[pin.modelId];
        const id = resolvedPin
            ? resolvedPin[mode]
            : pin?.resolvable
              ? pin.modelId
              : status?.reviewModels?.[mode]?.modelId;
        // Legacy name overrides still ride the organization's configured provider.
        const legacy = !config?.byokModelId?.value && config?.byokModel?.value;
        if (
            legacy &&
            !pin &&
            !getFieldState("byokModelId.value").isDirty &&
            status?.byok.configured
        )
            return labelOf(legacy);
        return id
            ? labelOf(id)
            : status?.env.model
              ? formatModelLabel(status.env.model)
              : "Kodus default";
    };
    return {
        canConfigure: hasConnectedProvider,
        riskModelInherited:
            status?.modelRouting?.riskAssessment.inherited !== false &&
            status?.modelRouting?.riskAssessment.modelId ===
                status?.modelRouting?.defaultModelId,
        active,
        heavyAllowed,
        ultraAllowed,
        ultraSet,
        configuredDefault,
        noRisk,
        riskFound,
        effectiveMode,
        modelFor,
        scopeModel,
        defaultMode: effectiveMode(configuredDefault),
        labelOf,
        defaultModel: labelOf(status?.modelRouting?.defaultModelId),
        fallbackModel: status?.modelRouting?.fallbackModelId
            ? labelOf(status.modelRouting.fallbackModelId)
            : "None",
        riskModel: status?.modelRouting?.riskAssessment.modelId
            ? labelOf(status.modelRouting.riskAssessment.modelId)
            : status?.env.model
              ? formatModelLabel(status.env.model)
              : "Kodus default",
    };
}
