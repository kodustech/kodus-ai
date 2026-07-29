"use client";

import { Card, CardContent, CardHeader } from "@components/ui/card";
import type { LLMConfigStatus } from "@services/organizationParameters/fetch";
import type { ByokModelCost } from "@services/usage/byok-cost";
import { KeyRoundIcon } from "lucide-react";

import curatedCatalog from "../../_data/curated-models.json";
import type { CuratedModel } from "../../_data/curated-models.types";
import type { BYOKConfigV2 } from "../../_types";
import { groupModelsByProvider, maskKey } from "../../_utils";
import { PROVIDER_LABELS } from "../catalog/model-card";

type ModelsTabProps = {
    config: BYOKConfigV2 | null | undefined;
    /** Per-model accumulated cost, keyed by BYOKModelConfig.id (04-08 renders it). */
    costByModelId?: Record<string, ByokModelCost>;
    teamId?: string;
    periodLabel?: string;
    costRangeQuery?: string;
    llmConfigStatus: LLMConfigStatus | null;
};

/** Curated display name for a model id, falling back to the raw id. */
const modelDisplayName = (modelId: string): string =>
    (curatedCatalog.models as CuratedModel[]).find((m) => m.id === modelId)
        ?.displayName ?? modelId;

/**
 * Read-only, provider-grouped pool of the org's configured v2 models. Managed
 * credentials are filtered out by groupModelsByProvider; every rendered key is
 * masked (secret hygiene). The interactive first-run card + add/edit/delete
 * flows land in 04-08 — this tracer only proves the v2 read path.
 */
export const ModelsTab = ({ config }: ModelsTabProps) => {
    const groups = groupModelsByProvider(config).filter(
        (g) => g.models.length > 0,
    );

    if (groups.length === 0) {
        return (
            <p className="text-text-tertiary text-sm">No model connected yet</p>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            {groups.map(({ credential, models }) => {
                const providerLabel =
                    PROVIDER_LABELS[credential.provider] ?? credential.provider;

                return (
                    <Card color="lv1" key={credential.id}>
                        <CardHeader className="flex-row items-center justify-between gap-3">
                            <span className="text-text-primary text-sm font-semibold text-balance">
                                {providerLabel}
                            </span>
                            <span className="text-text-tertiary flex items-center gap-1.5 font-mono text-xs">
                                <KeyRoundIcon size={12} />
                                {maskKey(credential.apiKey)}
                            </span>
                        </CardHeader>
                        <CardContent>
                            <ul className="flex flex-col gap-1.5">
                                {models.map((model) => (
                                    <li
                                        key={model.id}
                                        className="text-text-secondary text-sm">
                                        {modelDisplayName(model.model)}
                                    </li>
                                ))}
                            </ul>
                        </CardContent>
                    </Card>
                );
            })}
        </div>
    );
};
