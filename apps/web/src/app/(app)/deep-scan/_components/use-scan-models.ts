import { getLLMConfigStatus } from "@services/organizationParameters/fetch";
import { useQuery } from "@tanstack/react-query";
import { routingModelLabels } from "src/features/ee/byok/_components/routing/routing-state";

/**
 * The organization's own models a scan can run on, named as Routing names
 * them. The Kodus default is left out: a deep scan runs only on the
 * organization's own key. A model its connection cannot resolve is left out
 * too, as Routing does.
 */
export const useScanModels = () => {
    const status = useQuery({
        queryKey: ["deep-scan-scan-models"],
        queryFn: async () => (await getLLMConfigStatus()) ?? null,
        staleTime: 5 * 60 * 1000,
        retry: false,
    });
    const routable = status.data?.models ?? [];
    const labels = routingModelLabels(routable);
    const models = routable
        .filter((m) => m.resolvable && !m.managed)
        .map((m) => ({
            id: m.modelId,
            label: labels.get(m.modelId) ?? m.model ?? m.modelId,
        }));

    return {
        models,
        isLoading: status.isLoading,
        nameOf: (id?: string) => (id ? labels.get(id) : undefined),
    };
};
