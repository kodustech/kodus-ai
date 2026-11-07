"use client";

import { useFormContext, useWatch } from "react-hook-form";
import {
    useCodeReviewConfig,
    useCodeReviewModelData,
} from "src/app/(app)/settings/_components/context";
import { formatModelLabel } from "src/features/ee/byok/_data/model-label";
import { isHeavyModePlan } from "src/features/ee/heavy-mode/plan";
import { useSubscriptionContext } from "src/features/ee/subscription/_providers/subscription-context";

import type { CodeReviewFormType } from "../../../_types";

export type Mode = "balanced" | "heavy";
export const modeLabel = (mode: Mode) =>
    mode === "heavy" ? "Heavy" : "Balanced";

/** The same effective plan fallback and scope override the review uses. */
export function useReviewRouting() {
    const { control } = useFormContext<CodeReviewFormType>();
    const config = useCodeReviewConfig();
    const { llmConfigStatus: status } = useCodeReviewModelData();
    const heavyAllowed = isHeavyModePlan(useSubscriptionContext().license);
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
    const labelOf = (id?: string) => {
        const model = status?.models.find(
            (model) => model.modelId === id || model.model === id,
        );
        const name =
            model?.model ?? id ?? status?.byok.model ?? status?.env.model;
        return name ? formatModelLabel(name) : "Kodus default";
    };
    const effectiveMode = (mode: string): Mode =>
        mode === "heavy" && heavyAllowed ? "heavy" : "balanced";
    const modelFor = (mode: Mode) =>
        labelOf(scopeModel || status?.reviewModels?.[mode]?.modelId);
    return {
        active,
        heavyAllowed,
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
        riskModel: labelOf(status?.modelRouting?.riskAssessment.modelId),
    };
}
