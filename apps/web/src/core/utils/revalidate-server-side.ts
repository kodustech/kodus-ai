"use server";

import type { Route } from "next";
import { revalidatePath, updateTag } from "next/cache";

export const revalidateServerSidePath = async (
    path: Route,
    type?: "layout" | "page",
) => {
    revalidatePath(path, type);
};

// `updateTag`, not `revalidateTag`: every caller is a user-triggered mutation
// (team switch, onboarding finish) that must show fresh data on the next render.
// Next 16 turned `revalidateTag` into stale-while-revalidate and made the
// cacheLife profile a required second argument; `updateTag` keeps the previous
// expire-and-refresh-now semantics and is Server-Action only, which this is.
export const revalidateServerSideTag = async (tag: string) => {
    updateTag(tag);
};
