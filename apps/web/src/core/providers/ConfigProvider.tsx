"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { PublicConfig } from "@config/publicConfig";

const ConfigContext = createContext<PublicConfig | null>(null);

export function ConfigProvider({
    value,
    children,
}: {
    value: PublicConfig;
    children: ReactNode;
}) {
    return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

export function useConfig(): PublicConfig {
    const value = useContext(ConfigContext);
    if (!value) {
        throw new Error("useConfig() called outside of <ConfigProvider>");
    }
    return value;
}
