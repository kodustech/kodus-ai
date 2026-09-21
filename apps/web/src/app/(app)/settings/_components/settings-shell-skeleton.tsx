"use client";

import { SettingsPageSkeleton } from "src/core/components/system/page-skeletons";

/**
 * The whole settings shell while the server part of the layout (teams, LLM
 * status, defaults, platform config) is still streaming: the frame the
 * loaded shell uses, with a settings page skeleton inside.
 */
export const SettingsShellSkeleton = () => (
    <div className="flex flex-1 flex-col overflow-hidden">
        <SettingsPageSkeleton />
    </div>
);
