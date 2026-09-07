"use client";

import { createContext, forwardRef, useContext } from "react";
import { cn } from "src/core/utils/components";

import { Heading } from "../heading";

const PageContext = createContext<{
    hasSidebar: boolean;
}>({ hasSidebar: false });

const PageScrollableContext = createContext<boolean>(false);

export const PageWithSidebar = (props: React.PropsWithChildren) => {
    return (
        <PageContext.Provider value={{ hasSidebar: true }}>
            {props.children}
        </PageContext.Provider>
    );
};

// Every page is a centered column with the SAME cap: 80rem (1280px). Wide
// enough for the data tables (Kody Rules, Reviews, Issues, Cockpit), which
// used to opt out with `max-w-full` and made forms and tables start at
// different x positions. Don't override the cap per page.
const PAGE_CONTAINER = "mx-auto w-full max-w-7xl";
const WITH_SIDEBAR_CONTAINER = PAGE_CONTAINER;
const WITHOUT_SIDEBAR_CONTAINER = PAGE_CONTAINER;

export const PageRoot = ({
    scrollable,
    ...props
}: React.ComponentProps<"div"> & {
    scrollable?: false;
}) => {
    const { hasSidebar } = useContext(PageContext);

    return (
        <div
            {...props}
            className={cn(
                "relative flex w-full flex-1 flex-col gap-6 pt-10 pb-16",
                // Scroll on the shell by default. A page can opt out with
                // `scrollable={false}` (regardless of sidebar) when it owns an
                // internal scroll region — e.g. a virtualized table — so the app
                // doesn't end up with two nested scrollbars.
                scrollable !== false && "overflow-auto",
                props.className,
            )}>
            <PageScrollableContext.Provider value={scrollable ?? true}>
                {props.children}
            </PageScrollableContext.Provider>
        </div>
    );
};

export const PageContent = forwardRef<
    HTMLDivElement,
    React.ComponentProps<"div">
>((props, ref) => {
    const { hasSidebar } = useContext(PageContext);
    const hasParentScrollable = useContext(PageScrollableContext);

    return (
        <div
            {...props}
            ref={ref}
            className={cn(
                "flex flex-1 flex-col gap-6 px-8",
                hasSidebar && "flex-1",
                !hasParentScrollable && hasSidebar && "overflow-auto",
                hasSidebar ? WITH_SIDEBAR_CONTAINER : WITHOUT_SIDEBAR_CONTAINER,
                props.className,
            )}>
            {props.children}
        </div>
    );
});

export const PageHeader = (props: React.ComponentProps<"div">) => {
    const { hasSidebar } = useContext(PageContext);

    return (
        <div
            {...props}
            className={cn(
                "flex min-h-12 shrink-0 items-center justify-between gap-6 px-8",
                // A header whose only child rendered null (e.g. the code-review
                // breadcrumb under the tabs shell) must not keep its 48px.
                "empty:hidden",
                hasSidebar ? WITH_SIDEBAR_CONTAINER : WITHOUT_SIDEBAR_CONTAINER,
                props.className,
            )}>
            {props.children}
        </div>
    );
};

export const PageHeaderActions = (props: React.ComponentProps<"div">) => (
    <div
        data-header-actions
        className={cn(
            "flex items-center justify-between gap-2",
            props.className,
        )}>
        {props.children}
    </div>
);

export const PageDescription = (props: React.ComponentProps<"div">) => (
    <div
        {...props}
        className={cn("text-text-secondary text-sm", props.className)}>
        {props.children}
    </div>
);

export const PageTitleContainer = (props: React.ComponentProps<"div">) => (
    <div {...props} className={cn("flex flex-1 flex-col", props.className)}>
        {props.children}
    </div>
);

export const PageTitle = (props: React.ComponentProps<typeof Heading>) => (
    <Heading {...props} className={cn("font-medium", props.className)}>
        {props.children}
    </Heading>
);

export const PageFooter = (props: React.ComponentProps<"div">) => {
    const { hasSidebar } = useContext(PageContext);

    return (
        <div
            {...props}
            className={cn(
                "flex shrink-0 items-center justify-between gap-6 px-8",
                hasSidebar ? WITH_SIDEBAR_CONTAINER : WITHOUT_SIDEBAR_CONTAINER,
                props.className,
            )}>
            {props.children}
        </div>
    );
};
