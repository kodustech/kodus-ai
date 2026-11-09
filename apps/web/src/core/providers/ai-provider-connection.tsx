"use client";

import { createContext, useContext, type PropsWithChildren } from "react";

const AIProviderConnectionContext = createContext(false);

/** Navigation only needs connection state, never provider settings or secrets. */
export function AIProviderConnectionProvider({
    connected,
    children,
}: PropsWithChildren<{ connected: boolean }>) {
    return (
        <AIProviderConnectionContext.Provider value={connected}>
            {children}
        </AIProviderConnectionContext.Provider>
    );
}

export const useHasConnectedAIProvider = () =>
    useContext(AIProviderConnectionContext);
