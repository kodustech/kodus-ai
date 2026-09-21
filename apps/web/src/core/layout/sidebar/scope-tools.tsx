"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from "react";
import { createPortal } from "react-dom";

/**
 * The sidebar owns the code review scope picker, but some scope tools need
 * the full configuration that only the settings layout loads: the
 * repository's options menu, the kodus-config.yml badge and "Add repository
 * configuration". Rather than load that config for every page, the settings
 * layout lends them to the sidebar while it is mounted — the menu and badge
 * through portals into two slots, "actions" beside the picker and "status"
 * under it (so they keep the settings contexts they read), the add action as
 * a callback the picker calls.
 */
export type ScopeToolsSlot = "actions" | "status";

type ScopeTools = {
    slots: Record<ScopeToolsSlot, HTMLElement | null>;
    setActionsSlot: (element: HTMLElement | null) => void;
    setStatusSlot: (element: HTMLElement | null) => void;
    addRepository: (() => void) | undefined;
    setAddRepository: (open: (() => void) | undefined) => void;
};

const ScopeToolsContext = createContext<ScopeTools | null>(null);

export const ScopeToolsProvider = ({ children }: React.PropsWithChildren) => {
    const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
    const [statusSlot, setStatusSlot] = useState<HTMLElement | null>(null);
    const [addRepository, setAddRepositoryState] = useState<
        (() => void) | undefined
    >();
    // Wrapped: a function handed straight to a state setter would be called
    // as an updater.
    const setAddRepository = useCallback(
        (open: (() => void) | undefined) => setAddRepositoryState(() => open),
        [],
    );

    const value = useMemo<ScopeTools>(
        () => ({
            slots: { actions: actionsSlot, status: statusSlot },
            setActionsSlot,
            setStatusSlot,
            addRepository,
            setAddRepository,
        }),
        [actionsSlot, statusSlot, addRepository, setAddRepository],
    );

    return (
        <ScopeToolsContext.Provider value={value}>
            {children}
        </ScopeToolsContext.Provider>
    );
};

/** For the sidebar: where to mount the slot, and the lent add action. */
export const useScopeTools = () => useContext(ScopeToolsContext);

/** For the settings layout: renders `children` in one of the sidebar's slots. */
export const ScopeToolsPortal = ({
    slot,
    children,
}: React.PropsWithChildren<{ slot: ScopeToolsSlot }>) => {
    const element = useContext(ScopeToolsContext)?.slots[slot];
    return element ? createPortal(children, element) : null;
};

/** For the settings layout: offers "Add repository configuration". */
export const useLendAddRepository = (open: (() => void) | undefined) => {
    const setAddRepository = useContext(ScopeToolsContext)?.setAddRepository;

    useEffect(() => {
        setAddRepository?.(open);
        return () => setAddRepository?.(undefined);
    }, [open, setAddRepository]);
};
