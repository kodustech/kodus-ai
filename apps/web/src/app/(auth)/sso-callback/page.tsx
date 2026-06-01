"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { deleteCookie, getCookie } from "cookies-next";
import { signIn } from "next-auth/react";

import { useConfig } from "@providers/ConfigProvider";

export default function SsoCallbackPage() {
    const router = useRouter();
    const { nodeEnv } = useConfig();

    useEffect(() => {
        const domain = nodeEnv !== "development" ? ".kodus.io" : undefined;

        const handoffCookie = getCookie("sso_handoff", { domain });
        deleteCookie("sso_handoff", { domain });

        if (handoffCookie) {
            try {
                const tokens = JSON.parse(handoffCookie as string);

                signIn("sso", {
                    accessToken: tokens.accessToken,
                    refreshToken: tokens.refreshToken,
                    redirect: true,
                    redirectTo: "/",
                });
            } catch (e) {
                router.push("/sign-out");
            }
        } else {
            router.push("/sign-out");
        }
    }, [router, nodeEnv]);

    return (
        <div className="flex h-screen items-center justify-center">
            <div className="text-center">
                <h2 className="text-xl font-semibold">Authenticating...</h2>
                <p className="text-gray-500">
                    Please wait while we log you in.
                </p>
            </div>
        </div>
    );
}
