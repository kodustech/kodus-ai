"use client";

import {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useReducer,
} from "react";
import type { PullRequestSuggestion } from "@services/pull-requests";

interface ReviewState {
    selectedFilePath: string | null;
    viewMode: "split" | "unified";
    sidebarOpen: boolean;
    summaryPanelOpen: boolean;
    severityFilter: string | null;
    categoryFilter: string | null;
    /** Per-file "marked as viewed" state, shared by the file tree (shows a
        strike-through) and the diff viewer (collapses the file). */
    viewedFiles: Record<string, boolean>;
}

type ReviewAction =
    | { type: "SELECT_FILE"; path: string | null }
    | { type: "SET_VIEW_MODE"; mode: "split" | "unified" }
    | { type: "TOGGLE_SIDEBAR" }
    | { type: "TOGGLE_SUMMARY" }
    | { type: "SET_SEVERITY_FILTER"; severity: string | null }
    | { type: "SET_CATEGORY_FILTER"; category: string | null }
    | { type: "SET_VIEWED"; path: string; viewed: boolean };

const initialState: ReviewState = {
    selectedFilePath: null,
    viewMode: "unified",
    sidebarOpen: true,
    summaryPanelOpen: true,
    severityFilter: null,
    categoryFilter: null,
    viewedFiles: {},
};

function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
    switch (action.type) {
        case "SELECT_FILE":
            return { ...state, selectedFilePath: action.path };
        case "SET_VIEW_MODE":
            return { ...state, viewMode: action.mode };
        case "TOGGLE_SIDEBAR":
            return { ...state, sidebarOpen: !state.sidebarOpen };
        case "TOGGLE_SUMMARY":
            return {
                ...state,
                summaryPanelOpen: !state.summaryPanelOpen,
            };
        case "SET_SEVERITY_FILTER":
            return { ...state, severityFilter: action.severity };
        case "SET_CATEGORY_FILTER":
            return { ...state, categoryFilter: action.category };
        case "SET_VIEWED":
            return {
                ...state,
                viewedFiles: {
                    ...state.viewedFiles,
                    [action.path]: action.viewed,
                },
            };
        default:
            return state;
    }
}

interface ReviewContextValue {
    state: ReviewState;
    dispatch: React.Dispatch<ReviewAction>;
    fileGroups: Map<string, PullRequestSuggestion[]>;
    filePaths: string[];
    navigateFile: (direction: "next" | "prev") => void;
}

const ReviewContext = createContext<ReviewContextValue | null>(null);

export function ReviewStateProvider({
    children,
    suggestions,
    patchFilenames,
}: {
    children: React.ReactNode;
    suggestions: PullRequestSuggestion[];
    patchFilenames?: string[];
}) {
    const [state, dispatch] = useReducer(reviewReducer, initialState);

    const fileGroups = useMemo(() => {
        const groups = new Map<string, PullRequestSuggestion[]>();
        for (const s of suggestions) {
            if (!s.filePath) continue;
            const existing = groups.get(s.filePath) ?? [];
            existing.push(s);
            groups.set(s.filePath, existing);
        }
        return groups;
    }, [suggestions]);

    // Merge: files with suggestions + files from patches (even without suggestions)
    const filePaths = useMemo(() => {
        const pathSet = new Set<string>();
        for (const key of fileGroups.keys()) {
            pathSet.add(key);
        }
        if (patchFilenames) {
            for (const name of patchFilenames) {
                pathSet.add(name);
            }
        }
        return Array.from(pathSet).sort();
    }, [fileGroups, patchFilenames]);

    const navigateFile = useCallback(
        (direction: "next" | "prev") => {
            if (filePaths.length === 0) return;
            const currentIndex = state.selectedFilePath
                ? filePaths.indexOf(state.selectedFilePath)
                : -1;
            let nextIndex: number;
            if (direction === "next") {
                nextIndex =
                    currentIndex < filePaths.length - 1 ? currentIndex + 1 : 0;
            } else {
                nextIndex =
                    currentIndex > 0 ? currentIndex - 1 : filePaths.length - 1;
            }
            dispatch({ type: "SELECT_FILE", path: filePaths[nextIndex] });
        },
        [filePaths, state.selectedFilePath],
    );

    const value = useMemo(
        () => ({
            state,
            dispatch,
            fileGroups,
            filePaths,
            navigateFile,
        }),
        [state, dispatch, fileGroups, filePaths, navigateFile],
    );

    return (
        <ReviewContext.Provider value={value}>
            {children}
        </ReviewContext.Provider>
    );
}

export function useReviewStore() {
    const ctx = useContext(ReviewContext);
    if (!ctx)
        throw new Error(
            "useReviewStore must be used within ReviewStateProvider",
        );
    return ctx;
}
