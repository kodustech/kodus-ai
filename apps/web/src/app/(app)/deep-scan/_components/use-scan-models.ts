import {
    getBYOK,
    getLLMConfigStatus,
} from "@services/organizationParameters/fetch";
import { useQuery } from "@tanstack/react-query";
import { routingModelLabels } from "src/features/ee/byok/_components/routing/routing-state";

/**
 * The organization's own models a scan can run on, named as Routing names
 * them. The Kodus default is left out: a deep scan runs only on the
 * organization's own key. A model its connection cannot resolve is left out
 * too, as Routing does.
 *
 * `routingLabel` names the model a scan runs on when none is picked: the one
 * set for Deep scan in Routing, else the organization's default.
 */
export const useScanModels = () => {
    const status = useQuery({
        queryKey: ["deep-scan-scan-models"],
        queryFn: async () => (await getLLMConfigStatus()) ?? null,
        staleTime: 5 * 60 * 1000,
        retry: false,
    });
    // Routing lives in the stored config; a member who cannot read it still
    // gets a label that says where the model comes from.
    const routing = useQuery({
        queryKey: ["deep-scan-routing"],
        queryFn: async () => (await getBYOK())?.routing ?? null,
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

    const routedId =
        routing.data?.mode === "auto"
            ? undefined
            : (routing.data?.taskOverrides?.securityScan ??
              routing.data?.defaultModelId);
    const routedLabel = routedId ? labels.get(routedId) : undefined;

    return {
        models,
        isLoading: status.isLoading,
        nameOf: (id?: string) => (id ? labels.get(id) : undefined),
        routingLabel: routedLabel
            ? `${routedLabel} (from Routing)`
            : "the model set in Routing",
    };
};
