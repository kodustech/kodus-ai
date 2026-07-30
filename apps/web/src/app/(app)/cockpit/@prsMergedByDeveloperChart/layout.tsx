"use client";

import { use } from "react";
import { Button } from "@components/ui/button";
import { Card, CardHeader, CardTitle } from "@components/ui/card";
import useResizeObserver from "@hooks/use-resize-observer";
import { Maximize2Icon, Minimize2Icon } from "lucide-react";
import { ExpandableContext } from "src/core/providers/expandable";
import { cn } from "src/core/utils/components";
import { ExpandableCardsContext } from "src/features/ee/cockpit/_contexts/expandable-cards";

export default function Layout({ children }: React.PropsWithChildren) {
    const [ref, rect] = useResizeObserver();
    const { expanded, setExpanded } = use(ExpandableCardsContext);
    const isExpanded = expanded === "prs-merged-by-developer";

    return (
        <div ref={ref}>
            <Card
                color="lv1"
                style={{
                    ...(isExpanded && {
                        // top: rect.top,
                        height: rect.height,
                    }),
                }}
                className={cn(
                    "h-full",
                    isExpanded &&
                        "ring-tertiary-dark absolute inset-x-0 z-3 ring-8 **:transition-all",
                )}>
                <CardHeader className="relative flex flex-row justify-between">
                    <CardTitle className="text-sm">
                        PRs Merged By Developer
                    </CardTitle>

                    <Button
                        size="icon-sm"
                        variant="helper"
                        active={isExpanded}
                        className="absolute top-5 right-5"
                        onClick={() =>
                            setExpanded(
                                isExpanded
                                    ? undefined
                                    : "prs-merged-by-developer",
                            )
                        }>
                        {isExpanded ? <Minimize2Icon /> : <Maximize2Icon />}
                    </Button>
                </CardHeader>

                <ExpandableContext value={{ isExpanded }}>
                    {children}
                </ExpandableContext>
            </Card>
        </div>
    );
}
