"use client";

import { RouteSkeleton } from "../../_components/route-skeleton";

/**
 * The whole settings shell while the server part of the layout (teams, LLM
 * status, defaults, platform config) is still streaming: the frame the
 * loaded shell uses, with the target page's skeleton inside — this also
 * covers Repositories, Plugins and Subscription, which aren't card pages.
 */
export const SettingsShellSkeleton = () => (
    <div className="flex flex-1 flex-col overflow-hidden">
        <RouteSkeleton />
    </div>
);
