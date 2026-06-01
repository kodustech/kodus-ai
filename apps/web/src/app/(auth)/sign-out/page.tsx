"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Heading } from "@components/ui/heading";
import { Page } from "@components/ui/page";
import { Spinner } from "@components/ui/spinner";
import { useReactQueryInvalidateQueries } from "@hooks/use-invalidate-queries";
import { signOut } from "next-auth/react";
import { deleteFiltersInLocalStorage } from "src/app/(app)/issues/_constants";
import { getSetupCookieName } from "src/app/(setup)/setup/_components/setup-step-tracker";
import { ClientSideCookieHelpers } from "src/core/utils/cookie";

function SignOutContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { removeQueries } = useReactQueryInvalidateQueries();
    const reason = searchParams?.get("reason");

    useEffect(() => {
        const wipeOwnSetupCookie = async () => {
            try {
                const res = await fetch("/api/auth/session", {
                    cache: "no-store",
                });
                const session = await res.json();
                const userId = session?.user?.userId as string | undefined;
                if (userId) {
                    ClientSideCookieHelpers(getSetupCookieName(userId)).delete();
                }
            } catch {
                // Session fetch can fail if the auth cookie is already
                // invalid — that's fine, just means we can't target a
                // specific uuid this time. Logout still proceeds.
            }
        };

        const redirectToSignInPage = async () => {
            let callbackUrl = "/sign-in";

            // Add reason to callback URL if present
            if (reason) {
                callbackUrl += `?reason=${reason}`;
            }

            const data = await signOut({
                redirect: false,
                callbackUrl,
            });

            // remove this page from the history, for user to be unable to go back
            router.replace(data.url);
        };

        ClientSideCookieHelpers("global-selected-team-id").delete();
        ClientSideCookieHelpers("started-setup-from-new-setup-page").delete();
        ClientSideCookieHelpers("selectedTeam").delete();
        ClientSideCookieHelpers("cockpit-selected-date-range").delete();
        ClientSideCookieHelpers("cockpit-selected-repository").delete();

        deleteFiltersInLocalStorage();

        removeQueries();

        wipeOwnSetupCookie().finally(redirectToSignInPage);
    }, [reason, router, removeQueries]);

    return (
        <Page.Root className="flex h-full w-full flex-row items-center justify-center gap-8">
            <Spinner />
            <Heading variant="h3">Disconnecting...</Heading>
        </Page.Root>
    );
}

export default function App() {
    return (
        <Suspense
            fallback={
                <Page.Root className="flex h-full w-full flex-row items-center justify-center gap-8">
                    <Spinner />
                    <Heading variant="h3">Disconnecting...</Heading>
                </Page.Root>
            }>
            <SignOutContent />
        </Suspense>
    );
}
