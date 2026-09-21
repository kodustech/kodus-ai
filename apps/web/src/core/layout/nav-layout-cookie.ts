/**
 * Navigation experiment: the current top bar vs. everything in a left
 * sidebar. The choice lives in a cookie so the server renders the right shell
 * on the first paint, and it can be flipped from the avatar menu or with
 * `?nav=sidebar` / `?nav=top` on any URL (handy to hand a link to someone
 * testing it). Plain module: the server layout reads these values too.
 */
export type NavLayout = "top" | "sidebar";

export const NAV_LAYOUT_COOKIE = "kodus-nav-layout";

export const parseNavLayout = (value: string | undefined | null): NavLayout =>
    value === "sidebar" ? "sidebar" : "top";

/** "1" while the sidebar navigation is folded down to its icon rail. */
export const SIDEBAR_COLLAPSED_COOKIE = "kodus-sidebar-collapsed";
