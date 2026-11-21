"use client";

import type { ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@components/ui/tabs";

import type { UsageTab } from "../_lib/usage-tab";

/**
 * The Usage screen's tabs. The open tab is the URL's (`?tab=runtime`), so a
 * link can point at it; the other tab's content is not rendered.
 */
export const UsageTabs = ({
    active,
    llm,
    runtime,
}: {
    active: UsageTab;
    llm: ReactNode;
    runtime: ReactNode;
}) => {
    const router = useRouter();
    const pathname = usePathname();
    return (
        <Tabs
            value={active}
            onValueChange={(value) =>
                router.push(
                    value === "runtime" ? `${pathname}?tab=runtime` : pathname,
                )
            }>
            <TabsList>
                <TabsTrigger value="llm">LLM tokens</TabsTrigger>
                <TabsTrigger value="runtime">Runtime machines</TabsTrigger>
            </TabsList>
            <TabsContent value="llm">{active === "llm" && llm}</TabsContent>
            <TabsContent value="runtime">
                {active === "runtime" && runtime}
            </TabsContent>
        </Tabs>
    );
};
