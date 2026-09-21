"use client";

import { createContext, forwardRef, useContext } from "react";
import { cn } from "src/core/utils/components";

import { Heading } from "../heading";

const PageContext = createContext<{
    hasSidebar: boolean;
}>({ hasSidebar: false });

const PageScrollableContext = createContext<boolean>(false);

const PageBelowTabsContext = createContext<boolean>(false);

export const PageWithSidebar = (props: React.PropsWithChildren) => {
    return (
        <PageContext.Provider value={{ hasSidebar: true }}>
            {props.children}
        </PageContext.Provider>
    );
};

// For pages rendered under a band of tabs (the code review settings shell).
// The band already separates the page from the navbar, so the usual top
// padding left a dead zone between the tabs and the title. Set once by the
// shell instead of every page overriding Page.Root's padding by hand.
export const PageBelowTabs = (props: React.PropsWithChildren) => {
    return (
        <PageBelowTabsContext.Provider value>
            {props.children}
        </PageBelowTabsContext.Provider>
    );
};

// Every page is a centered column with the SAME cap: 96rem (1536px). Wide
// enough for the data tables (Kody Rules, Reviews, Issues, Cockpit), which
// used to opt out with `max-w-full` and made forms and tables start at
// different x positions. Don't override the cap per page.
//
// Raised from 80rem: on a 1720px window that cap left 220px of dead margin
// on each side — a quarter of the screen — while table rows truncated. Text
// columns don't get longer as a result; the prose on the settings pages is
// sized by its own container, not by this one (measured identical at both
// caps), so the extra width lands on the tables that wanted it.
// Exported because a few chrome elements live OUTSIDE Page.Root and still
// have to line up with it — the settings tab bar, its skeleton, the Cockpit
// empty-state banner. They each hard-coded the old value, so raising the cap
// here alone would have left them narrower than the content beneath them.
// Import this instead of repeating the number.
export const PAGE_MAX_WIDTH = "max-w-[96rem]";
const PAGE_CONTAINER = `mx-auto w-full ${PAGE_MAX_WIDTH}`;
const WITH_SIDEBAR_CONTAINER = PAGE_CONTAINER;
const WITHOUT_SIDEBAR_CONTAINER = PAGE_CONTAINER;

export const PageRoot = ({
    scrollable,
    ...props
}: React.ComponentProps<"div"> & {
    scrollable?: false;
}) => {
    const belowTabs = useContext(PageBelowTabsContext);

    return (
        <div
            {...props}
            className={cn(
                // A sticky Page.Header offsets itself by this same padding —
                // change them together.
                "relative flex w-full flex-1 flex-col gap-6 pb-16",
                belowTabs ? "pt-4" : "pt-10",
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

export const PageHeader = ({
    sticky,
    ...props
}: React.ComponentProps<"div"> & {
    /**
     * Pin the header while the page scrolls. Opt-in, because most pages are
     * short enough that a header scrolling away costs nothing — but a long
     * column of form controls whose ONLY save action lives up here strands the
     * reader: flip a toggle near the bottom and the way to keep it is off
     * screen, with nothing down there saying anything is unsaved.
     *
     * Reads as chrome, not content: a solid surface with a hairline rule,
     * so the page docks underneath instead of mashing into the bar.
     * Same treatment as the sticky table headers — translucency was tried
     * here and failed: white card text stays readable through 20% bleed.
     */
    sticky?: boolean;
}) => {
    const { hasSidebar } = useContext(PageContext);
    const insideScrollingRoot = useContext(PageScrollableContext);
    const belowTabs = useContext(PageBelowTabsContext);

    return (
        <div
            {...props}
            className={cn(
                "flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-3 px-8",
                sticky &&
                    "bg-background border-card-lv3/40 sticky top-0 z-20 border-b py-2",
                // The browser docks a sticky child at its scroll container's
                // PADDING edge, so at top-0 the bar stuck Page.Root's top
                // padding below the chrome, with content scrolling in the gap.
                // Pull it back by that same padding.
                sticky &&
                    insideScrollingRoot &&
                    (belowTabs ? "-top-4" : "-top-10"),
                // A header whose only child rendered null must not keep its 48px.
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
        className={cn("flex flex-wrap items-center gap-2", props.className)}>
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
    <div
        {...props}
        className={cn(
            "flex min-w-[min(100%,22rem)] flex-1 flex-col",
            props.className,
        )}>
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
