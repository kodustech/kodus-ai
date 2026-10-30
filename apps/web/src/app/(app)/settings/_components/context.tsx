"use client";

import { createContext, useContext } from "react";
import type {
    LLMConfigStatus,
    LLMProviderModel,
} from "@services/organizationParameters/fetch";
import { PlatformConfigValue } from "@services/parameters/types";
import { CustomMessageConfig } from "@services/pull-request-messages/types";
import { FEATURE_FLAGS } from "src/core/config/feature-flags";

import { useCodeReviewRouteParams } from "../_hooks";
import type {
    CodeReviewGlobalConfig,
    FormattedGlobalCodeReviewConfig,
} from "../code-review/_types";
import {
    resolveCodeReviewConfigForScope,
    type ScopedCodeReviewConfig,
} from "./code-review-config-scope";

const AutomationCodeReviewConfigContext =
    createContext<FormattedGlobalCodeReviewConfig>(
        {} as FormattedGlobalCodeReviewConfig,
    );

const ScopedCodeReviewConfigContext = createContext<
    ScopedCodeReviewConfig | undefined
>(undefined);

export const useCodeReviewConfig = (): ScopedCodeReviewConfig | undefined => {
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const scopedContext = useContext(ScopedCodeReviewConfigContext);
    if (scopedContext) {
        return scopedContext;
    }

    return resolveCodeReviewConfigForScope(
        useFullCodeReviewConfig(),
        repositoryId,
        directoryId,
    );
};

export const useFullCodeReviewConfig = (): FormattedGlobalCodeReviewConfig => {
    const context = useContext(AutomationCodeReviewConfigContext);

    if (!context) {
        throw new Error(
            "useAutomationCodeReviewConfig needs AutomationCodeReviewConfigContext to work",
        );
    }

    return context;
};

export const AutomationCodeReviewConfigProvider = (
    props: React.PropsWithChildren & {
        config: FormattedGlobalCodeReviewConfig;
    },
) => (
    <AutomationCodeReviewConfigContext.Provider value={props.config}>
        {props.children}
    </AutomationCodeReviewConfigContext.Provider>
);

export const ScopedCodeReviewConfigProvider = (
    props: React.PropsWithChildren & {
        config: ScopedCodeReviewConfig | undefined;
    },
) => (
    <ScopedCodeReviewConfigContext.Provider value={props.config}>
        {props.children}
    </ScopedCodeReviewConfigContext.Provider>
);

const PlatformConfigContext = createContext<PlatformConfigValue>(
    {} as PlatformConfigValue,
);

export const usePlatformConfig = () => {
    return useContext(PlatformConfigContext);
};

export const PlatformConfigProvider = (
    props: React.PropsWithChildren & {
        config: PlatformConfigValue;
    },
) => (
    <PlatformConfigContext.Provider value={props.config}>
        {props.children}
    </PlatformConfigContext.Provider>
);

const DefaultCodeReviewConfigContext = createContext<
    CodeReviewGlobalConfig & {
        customMessages: CustomMessageConfig;
    }
>(
    {} as CodeReviewGlobalConfig & {
        customMessages: CustomMessageConfig;
    },
);

export const useDefaultCodeReviewConfig = () => {
    return useContext(DefaultCodeReviewConfigContext);
};

export const DefaultCodeReviewConfigProvider = (
    props: React.PropsWithChildren & {
        config: CodeReviewGlobalConfig & {
            customMessages: CustomMessageConfig;
        };
    },
) => (
    <DefaultCodeReviewConfigContext.Provider value={props.config}>
        {props.children}
    </DefaultCodeReviewConfigContext.Provider>
);

const FeatureFlagsContext = createContext<
    Partial<{
        [K in keyof typeof FEATURE_FLAGS]: boolean | undefined;
    }>
>(
    {} as Partial<{
        [K in keyof typeof FEATURE_FLAGS]: boolean | undefined;
    }>,
);

export const useFeatureFlags = () => {
    return useContext(FeatureFlagsContext);
};

export const FeatureFlagsProvider = (
    props: React.PropsWithChildren & {
        featureFlags: Partial<{
            [K in keyof typeof FEATURE_FLAGS]: boolean | undefined;
        }>;
    },
) => (
    <FeatureFlagsContext.Provider value={props.featureFlags}>
        {props.children}
    </FeatureFlagsContext.Provider>
);

/**
 * Data the BYOK model selector needs — the LLM config status (BYOK / env /
 * none) and the provider's model catalog. Both are server-fetched in the
 * settings layout and provided here so the selector renders fully with the
 * rest of the page: no client round-trip, no loading skeleton.
 */
export type CodeReviewModelData = {
    llmConfigStatus: LLMConfigStatus | null;
    byokModels: LLMProviderModel[];
};

const CodeReviewModelDataContext = createContext<CodeReviewModelData>({
    llmConfigStatus: null,
    byokModels: [],
});

export const useCodeReviewModelData = () =>
    useContext(CodeReviewModelDataContext);

export const CodeReviewModelDataProvider = (
    props: React.PropsWithChildren & { value: CodeReviewModelData },
) => (
    <CodeReviewModelDataContext.Provider value={props.value}>
        {props.children}
    </CodeReviewModelDataContext.Provider>
);

/**
 * Fetch state of the client-side code review config query. The
 * kodus-config.yml overlay is only ever requested there — the server render
 * deliberately skips it — so the UI needs to tell "the overlay is still on its
 * way" from "the overlay failed", and neither from stored config.
 */
export type CodeReviewConfigFetchState = {
    isFetching: boolean;
    isError: boolean;
};

const CodeReviewConfigFetchStateContext =
    createContext<CodeReviewConfigFetchState>({
        isFetching: false,
        isError: false,
    });

export const useCodeReviewConfigFetchState = (): CodeReviewConfigFetchState =>
    useContext(CodeReviewConfigFetchStateContext);

export const CodeReviewConfigFetchStateProvider = (
    props: React.PropsWithChildren & { value: CodeReviewConfigFetchState },
) => (
    <CodeReviewConfigFetchStateContext.Provider value={props.value}>
        {props.children}
    </CodeReviewConfigFetchStateContext.Provider>
);

export { resolveCodeReviewConfigForScope };

/**
 * Generic bridge for SSR-seeded parameter values.
 * Keyed by ParametersConfigKey, so any new parameter only adds a key — no new provider.
 * Carries `initialTeamId` so consumers can guard: only apply the seed when
 * the active team matches the one the seed was fetched for (same pattern as
 * the shell's `effectiveTeamId === initialTeamId` check).
 */
type InitialParameterValue = {
    uuid: string;
    configKey: string;
    configValue: string;
} | null;

type InitialParametersBridge = {
    initialTeamId: string;
    parameters: Partial<Record<string, InitialParameterValue>>;
};

const InitialParametersContext = createContext<InitialParametersBridge>({
    initialTeamId: "",
    parameters: {},
});

export const useInitialTeamId = (): string => {
    return useContext(InitialParametersContext).initialTeamId;
};

export const useInitialParameter = (key: string): InitialParameterValue => {
    const { parameters } = useContext(InitialParametersContext);
    return parameters[key] ?? null;
};

export const InitialParametersProvider = (
    props: React.PropsWithChildren & {
        value: InitialParametersBridge;
    },
) => (
    <InitialParametersContext.Provider value={props.value}>
        {props.children}
    </InitialParametersContext.Provider>
);
