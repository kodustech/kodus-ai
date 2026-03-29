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

const WITH_SIDEBAR_CONTAINER = "max-w-(--breakpoint-lg)";
const WITHOUT_SIDEBAR_CONTAINER = "max-w-(--breakpoint-lg)";

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
                (!hasSidebar || scrollable === undefined) && "overflow-auto",
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
                "container flex flex-1 flex-col gap-6",
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
                "container flex min-h-12 shrink-0 items-center justify-between gap-6",
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
                "container flex shrink-0 items-center justify-between gap-6",
                hasSidebar ? WITH_SIDEBAR_CONTAINER : WITHOUT_SIDEBAR_CONTAINER,
                props.className,
            )}>
            {props.children}
        </div>
    );
};
