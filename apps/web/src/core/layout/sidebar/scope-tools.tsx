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
 * a callback the picker calls, and the override counts as a render function
 * the picker and the page links call per scope.
 */
export type ScopeToolsSlot = "actions" | "status";

export type ScopeTarget = { repositoryId: string; directoryId?: string };

/** How many settings `scope` overrides across `pages`; nothing when none. */
export type RenderOverrideCount = (request: {
    scope: ScopeTarget;
    pages: string[];
}) => React.ReactNode;

type ScopeTools = {
    slots: Record<ScopeToolsSlot, HTMLElement | null>;
    /** The sidebar is the icon rail: lent tools render in their compact form. */
    compact: boolean;
    setCompact: (compact: boolean) => void;
    setActionsSlot: (element: HTMLElement | null) => void;
    setStatusSlot: (element: HTMLElement | null) => void;
    addRepository: (() => void) | undefined;
    setAddRepository: (open: (() => void) | undefined) => void;
    renderOverrideCount: RenderOverrideCount | undefined;
    setRenderOverrideCount: (render: RenderOverrideCount | undefined) => void;
};

const ScopeToolsContext = createContext<ScopeTools | null>(null);

export const ScopeToolsProvider = ({ children }: React.PropsWithChildren) => {
    const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
    const [statusSlot, setStatusSlot] = useState<HTMLElement | null>(null);
    const [compact, setCompact] = useState(false);
    const [addRepository, setAddRepositoryState] = useState<
        (() => void) | undefined
    >();
    const [renderOverrideCount, setRenderOverrideCountState] = useState<
        RenderOverrideCount | undefined
    >();
    // Wrapped: a function handed straight to a state setter would be called
    // as an updater.
    const setAddRepository = useCallback(
        (open: (() => void) | undefined) => setAddRepositoryState(() => open),
        [],
    );
    const setRenderOverrideCount = useCallback(
        (render: RenderOverrideCount | undefined) =>
            setRenderOverrideCountState(() => render),
        [],
    );

    const value = useMemo<ScopeTools>(
        () => ({
            slots: { actions: actionsSlot, status: statusSlot },
            compact,
            setCompact,
            setActionsSlot,
            setStatusSlot,
            addRepository,
            setAddRepository,
            renderOverrideCount,
            setRenderOverrideCount,
        }),
        [
            actionsSlot,
            statusSlot,
            compact,
            addRepository,
            setAddRepository,
            renderOverrideCount,
            setRenderOverrideCount,
        ],
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

/** For the settings layout: offers the override counts. */
export const useLendOverrideCount = (
    render: RenderOverrideCount | undefined,
) => {
    const setRenderOverrideCount =
        useContext(ScopeToolsContext)?.setRenderOverrideCount;

    useEffect(() => {
        setRenderOverrideCount?.(render);
        return () => setRenderOverrideCount?.(undefined);
    }, [render, setRenderOverrideCount]);
};
