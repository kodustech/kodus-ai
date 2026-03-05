"use client";

import { Heading } from "@components/ui/heading";
import { Link } from "@components/ui/link";
import { Page } from "@components/ui/page";
import AuthPageHeader from "src/app/(auth)/components/auth-page-header";

export default function EmailSentPage() {
    return (
        <Page.Root className="flex h-full w-full flex-col items-center overflow-auto py-20">
            <div className="flex w-[90%] flex-1 flex-col items-center justify-center gap-10 md:max-w-[500px]">
                <AuthPageHeader />

                <Page.Content className="flex-none gap-4">
                    <Heading variant="h2" className="text-center">
                        Password successfully reset
                    </Heading>
                    <p className="text-text-secondary text-center text-sm">
                        You can now log in with your new password
                    </p>
                    <Link
                        className="mx-auto mt-4 text-center text-sm"
                        href="/sign-in">
                        Back to Log in
                    </Link>
                </Page.Content>
            </div>
        </Page.Root>
    );
}
