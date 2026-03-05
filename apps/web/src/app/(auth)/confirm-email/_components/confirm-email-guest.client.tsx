"use client";

import { useRouter } from "next/navigation";
import { Link } from "@components/ui/link";
import { Page } from "@components/ui/page";

import AuthPageHeader from "../../components/auth-page-header";
import { ConfirmEmailForm } from "./confirm-email-form.client";

export const ConfirmEmailGuestView = () => {
    const router = useRouter();

    return (
        <Page.Root className="flex h-full w-full flex-col items-center overflow-auto py-20">
            <div className="flex w-[90%] flex-1 flex-col items-center justify-center gap-10 md:max-w-[500px]">
                <AuthPageHeader />

                <Page.Content className="flex-none gap-4">
                    <ConfirmEmailForm
                        onSuccess={() => router.push("/sign-in")}
                    />

                    <Link
                        className="mx-auto mt-4 text-center text-sm"
                        href="/sign-in">
                        Back to Log in
                    </Link>
                </Page.Content>
            </div>
        </Page.Root>
    );
};
