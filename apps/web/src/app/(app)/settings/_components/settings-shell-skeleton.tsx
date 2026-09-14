"use client";

import { Skeleton } from "@components/ui/skeleton";
import { SettingsPageSkeleton } from "src/core/components/system/page-skeletons";

// General · What to review · Kody Rules · What Kody writes · Linked repos
const TAB_WIDTHS_REM = [3.5, 6.5, 5.5, 7.5, 8];

/** The tabs-shell header band (scope pill + page tabs) while config loads. */
export const SettingsShellHeaderSkeleton = () => (
    <div
        className="bg-card-lv1 border-card-lv3/60 shrink-0 border-b px-8"
        aria-hidden>
        <div className="mx-auto flex h-12 w-full max-w-7xl items-center gap-6">
            <Skeleton className="h-8 w-28 rounded-lg" />
            <div className="flex items-center gap-5">
                {TAB_WIDTHS_REM.map((width, i) => (
                    <Skeleton
                        key={i}
                        className="h-4"
                        style={{ width: `${width}rem` }}
                    />
                ))}
            </div>
        </div>
    </div>
);

/**
 * Whole settings shell while the server part of the layout (teams, LLM
 * status, defaults, platform config) is still streaming: the same frame the
 * loaded shell uses in each mode, with a settings page skeleton inside.
 */
/**
 * The whole settings shell while the server part of the layout (teams, LLM
 * status, defaults, platform config) is still streaming: the frame the
 * loaded shell uses, with a settings page skeleton inside.
 */
export const SettingsShellSkeleton = () => (
    <div className="flex flex-1 flex-col overflow-hidden">
        <SettingsShellHeaderSkeleton />
        <SettingsPageSkeleton />
    </div>
);
