"use client";

import { createContext, useContext, type PropsWithChildren } from "react";

/**
 * Which settings shell is mounted: the classic side rail, or the alpha
 * `settings-tabs-shell` (scope switcher + page tabs, no rail). Pages read
 * it to drop chrome the header already provides (e.g. the breadcrumb).
 */
export type SettingsShellMode = "rail" | "tabs";

const SettingsShellModeContext = createContext<SettingsShellMode>("rail");

export const SettingsShellModeProvider = ({
    value,
    children,
}: PropsWithChildren<{ value: SettingsShellMode }>) => (
    <SettingsShellModeContext.Provider value={value}>
        {children}
    </SettingsShellModeContext.Provider>
);

export const useSettingsShellMode = () => useContext(SettingsShellModeContext);
