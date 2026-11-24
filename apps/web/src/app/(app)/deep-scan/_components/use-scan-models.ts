import { getBYOK } from "@services/organizationParameters/fetch";
import { useQuery } from "@tanstack/react-query";
import {
    routingModelLabels,
    routingModelsFromConfig,
} from "src/features/ee/byok/_components/routing/routing-state";
import type { BYOKConfig } from "src/features/ee/byok/_types";

/**
 * The organization's own models a scan can run on, named as Routing names
 * them. The Kodus default is left out: a deep scan runs only on the
 * organization's own key.
 */
export const useScanModels = () => {
    const byok = useQuery({
        queryKey: ["deep-scan-byok-models"],
        queryFn: async () => ((await getBYOK()) ?? null) as BYOKConfig | null,
        staleTime: 5 * 60 * 1000,
        retry: false,
    });
    const routable = routingModelsFromConfig(byok.data);
    const labels = routingModelLabels(routable);
    const models = routable
        .filter((m) => !m.managed)
        .map((m) => ({
            id: m.modelId,
            label: labels.get(m.modelId) ?? m.model,
        }));

    return {
        models,
        isLoading: byok.isLoading,
        nameOf: (id?: string) => (id ? labels.get(id) : undefined),
    };
};
