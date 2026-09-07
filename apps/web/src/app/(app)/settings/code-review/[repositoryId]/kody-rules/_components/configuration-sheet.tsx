"use client";

import { Suspense } from "react";
import { ScrollArea } from "@components/ui/scroll-area";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "@components/ui/sheet";
import { Skeleton } from "@components/ui/skeleton";

import { GenerateRulesOptions } from "../../../_components/generate-rules-options";
import { GlobalRulesSourceSetting } from "./global-rules-source-setting";
import { KodyKnowledgeApprovalSetting } from "./knowledge-approval";

/**
 * The scope's rule-creation settings (approval gate, auto-sync from repo
 * files, global rule sources) in a side panel, so the list stays on screen
 * while a setting is flipped.
 */
export const KodyRulesConfigurationSheet = ({
    open,
    onOpenChange,
    isRepoView,
    isGlobalView,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    isRepoView: boolean;
    isGlobalView: boolean;
}) => (
    <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="gap-0 py-0 sm:max-w-xl">
            <SheetHeader className="border-card-lv3/60 border-b px-6 pt-5 pb-4">
                <SheetTitle>Configuration</SheetTitle>
                <SheetDescription>
                    How rules and memories get created and approved for this
                    scope.
                </SheetDescription>
            </SheetHeader>

            <ScrollArea className="min-h-0 flex-1">
                <div className="flex flex-col gap-3 px-6 py-5">
                    <KodyKnowledgeApprovalSetting />

                    {isRepoView && (
                        <Suspense fallback={<Skeleton className="h-15" />}>
                            <GenerateRulesOptions />
                        </Suspense>
                    )}

                    {isGlobalView && (
                        <Suspense fallback={<Skeleton className="h-15" />}>
                            <GlobalRulesSourceSetting />
                        </Suspense>
                    )}
                </div>
            </ScrollArea>
        </SheetContent>
    </Sheet>
);
