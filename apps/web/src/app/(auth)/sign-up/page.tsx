import { Suspense } from "react";
import { Metadata } from "next";
import { Heading } from "@components/ui/heading";
import { SvgKodus } from "@components/ui/icons/SvgKodus";
import { Link } from "@components/ui/link";
import { Page } from "@components/ui/page";
import { ScrollArea } from "@components/ui/scroll-area";

import { RegisterPageContent } from "../components/register-page-content";

export const metadata: Metadata = {
    title: "Sign Up",
};

export default function RegisterPage() {
    return (
        <Page.Root className="mx-auto flex max-h-screen flex-row overflow-hidden p-6">
            <div className="bg-card-lv1 hidden flex-10 flex-col justify-center gap-10 rounded-3xl p-12 md:flex">
                <SvgKodus className="h-8 min-h-8" />

                <div className="flex flex-1 flex-col justify-center gap-10">
                    <Heading variant="h1" className="text-[calc(3vh)]">
                        Join thousands of teams automating code reviews with
                        Kody
                    </Heading>

                    <div className="overflow-hidden rounded-3xl">
                        <video
                            loop
                            muted
                            autoPlay
                            playsInline
                            disablePictureInPicture
                            className="h-full w-full object-contain"
                            src="/assets/videos/setup/presentation.webm"
                        />
                    </div>

                    <div className="flex flex-col items-end">
                        <p className="text-base font-bold">
                            It only takes 2 minutes to set up!
                        </p>

                        <p className="text-text-secondary text-sm">
                            Yes, we timed it.
                        </p>
                    </div>
                </div>
            </div>

            <div className="flex flex-14 flex-col justify-center overflow-auto">
                <ScrollArea type="auto">
                    <div className="flex flex-col items-center gap-10 py-10">
                        <SvgKodus className="h-8 min-h-8 md:hidden" />

                        <Suspense>
                            <div className="max-w-96">
                                <RegisterPageContent />
                            </div>
                        </Suspense>

                        <div className="text-text-secondary text-center text-[13px]">
                            Already have an account?{" "}
                            <Link href="/sign-in">Log in</Link>
                        </div>
                    </div>
                </ScrollArea>
            </div>
        </Page.Root>
    );
}
