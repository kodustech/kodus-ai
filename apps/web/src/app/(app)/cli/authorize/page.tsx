import type { Metadata } from "next";

import { CliAuthorizeClient } from "./_components/page.client";

export const metadata: Metadata = {
    title: "Authorize CLI",
};

export default async function CliAuthorizePage({
    searchParams,
}: {
    searchParams: Promise<{ state?: string; code?: string }>;
}) {
    const { state, code } = await searchParams;
    return <CliAuthorizeClient state={state} userCode={code} />;
}
