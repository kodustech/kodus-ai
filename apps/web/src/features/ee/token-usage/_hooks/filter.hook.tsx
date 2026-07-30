"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useDebounce } from "@hooks/use-debounce";
import { seedSelectedModels } from "./seed-models";

export const useTokenUsageFilters = (models: string[]) => {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const currentFilter = searchParams.get("filter") ?? "daily";

    // Filter/model/date changes are client-side navigations (router.replace)
    // that re-run the server component. Next keeps the current UI during a
    // same-segment param change (no loading.tsx), so without a transition the
    // screen looks frozen for seconds. useTransition surfaces that pending
    // window so the UI can show a loading overlay.
    const [isPending, startTransition] = useTransition();
    // Skip no-op navigations. The prNumber/developer effects below depend on
    // `searchParams`, so every router.replace re-fires them; without this guard
    // they keep re-issuing a semantically-identical URL and spin into a reload
    // loop (worsened once the `?models=` seed effect writes to the URL on
    // mount). Compare order-independently so `a=1&b=2` == `b=2&a=1`.
    const normalizeQuery = (query: string) => {
        const params = new URLSearchParams(query);
        params.sort();
        return params.toString();
    };
    const navigate = (url: string) => {
        const nextQuery = normalizeQuery(url.split("?")[1] ?? "");
        if (nextQuery === normalizeQuery(searchParams.toString())) return;
        startTransition(() => router.replace(url));
    };

    // Seed the model selection from `?models=` so a deep-link (e.g. the BYOK
    // per-model cost chip) opens the screen already scoped to that model.
    // Intersect with the available models; an unknown/empty value falls back to
    // "all models". Without this seed the mirror effect below would see the
    // full selection on mount and strip the incoming `?models=` param.
    const [selectedModels, setSelectedModels] = useState<string[]>(() =>
        seedSelectedModels(searchParams.get("models"), models),
    );

    // Keep selection in sync when the upstream `models` list changes —
    // switching filter (daily/by-pr/by-developer) yields a different
    // aggregation and can swap which models exist. Without this the dropdown
    // claims "N selected" against models that aren't in the list anymore.
    const modelsKey = models.join("|");
    useEffect(() => {
        setSelectedModels((prev) => {
            const stillPresent = prev.filter((m) => models.includes(m));
            return stillPresent.length === 0 ? models : stillPresent;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [modelsKey]);

    const [prNumber, setPrNumber] = useState(
        searchParams.get("prNumber") ?? "",
    );
    const debouncedPrNumber = useDebounce(prNumber, 500);

    const [developer, setDeveloper] = useState(
        searchParams.get("developer") ?? "",
    );
    const debouncedDeveloper = useDebounce(developer, 500);

    const selectedRepositoryId = searchParams.get("repositoryId") ?? "";

    const handleRepositoryChange = (repositoryId: string) => {
        const params = new URLSearchParams(searchParams.toString());
        if (repositoryId) params.set("repositoryId", repositoryId);
        else params.delete("repositoryId");
        navigate(`${pathname}?${params.toString()}`);
    };

    // Direct selection from the developer combobox — set (or clear) the
    // developer scope immediately, mirroring the repo picker. Keep the local
    // `developer` state in sync so the debounced effect below doesn't fight it.
    const handleDeveloperSelect = (developerName: string) => {
        setDeveloper(developerName);
        const params = new URLSearchParams(searchParams.toString());
        if (developerName) params.set("developer", developerName);
        else params.delete("developer");
        navigate(`${pathname}?${params.toString()}`);
    };

    const handleFilterChange = (value: string) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set("filter", value);
        if (value !== "by-pr") {
            params.delete("prNumber");
        }
        if (value !== "by-developer") {
            params.delete("developer");
        }
        navigate(`${pathname}?${params.toString()}`);
    };

    const handleModelChange = (model: string) => {
        const updatedModels = selectedModels.includes(model)
            ? selectedModels.filter((m) => m !== model)
            : [...selectedModels, model];

        setSelectedModels(updatedModels);
    };

    useEffect(() => {
        const params = new URLSearchParams(searchParams.toString());

        if (debouncedPrNumber) {
            params.set("prNumber", debouncedPrNumber);
        } else {
            params.delete("prNumber");
        }

        navigate(`${pathname}?${params.toString()}`);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [debouncedPrNumber, pathname, searchParams]);

    useEffect(() => {
        const params = new URLSearchParams(searchParams.toString());

        if (debouncedDeveloper) {
            params.set("developer", debouncedDeveloper);
        } else {
            params.delete("developer");
        }

        navigate(`${pathname}?${params.toString()}`);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [debouncedDeveloper, pathname, searchParams]);

    // Mirror the model selection back into `?models=` so the scope survives
    // reload/share and matches what a deep-link would produce. Written only for
    // a proper subset; cleared for all/none (both mean "All models", see
    // getModelSelectionText). Keyed on the selection so URL churn doesn't loop.
    const selectedModelsKey = selectedModels.join(",");
    useEffect(() => {
        const params = new URLSearchParams(searchParams.toString());
        const isSubset =
            selectedModels.length > 0 &&
            selectedModels.length < models.length;
        if (isSubset) {
            params.set("models", selectedModelsKey);
        } else {
            params.delete("models");
        }
        // Use `navigate` (startTransition) like the other filter effects so the
        // isPending flag drives the loading skeleton — a bare router.replace
        // would swap data with no pending state, leaving stale charts on screen.
        navigate(`${pathname}?${params.toString()}`);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedModelsKey, models.length]);

    const handlePrNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPrNumber(e.target.value);
    };

    const handleDeveloperChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setDeveloper(e.target.value);
    };

    const getModelSelectionText = () => {
        if (
            selectedModels.length === models.length ||
            selectedModels.length === 0
        ) {
            return "All models";
        }
        if (selectedModels.length === 1) {
            return selectedModels[0];
        }
        return `${selectedModels.length} models selected`;
    };

    return {
        currentFilter,
        isPending,
        selectedModels,
        prNumber,
        developer,
        selectedRepositoryId,
        handleRepositoryChange,
        handleFilterChange,
        handleModelChange,
        handlePrNumberChange,
        handleDeveloperChange,
        handleDeveloperSelect,
        getModelSelectionText,
        setSelectedModels,
    };
};
