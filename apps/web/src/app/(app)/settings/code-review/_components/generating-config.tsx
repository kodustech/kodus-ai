import { Heading } from "@components/ui/heading";
import { Image } from "@components/ui/image";
import { Page } from "@components/ui/page";
import { cn } from "src/core/utils/components";

export default function GeneratingConfig() {
    return (
        <Page.Root className="flex flex-row items-center justify-center">
            <div
                className={cn(
                    "flex max-w-3xl flex-col items-start px-6",
                    "xl:flex-row xl:items-center xl:justify-start xl:gap-6 xl:px-0",
                )}>
                <div className="w-64 shrink-0">
                    <Image alt="" src="/assets/images/kody/chemicals.png" />
                </div>

                <div className={cn("flex flex-col gap-4 px-6", "xl:px-0")}>
                    <Heading variant="h2">
                        Kody is calibrating your review engine...
                    </Heading>

                    <p>
                        She’s digging into your past PRs to understand how your
                        team works — and how to help you merge faster.
                    </p>

                    <small className="italic">
                        This usually takes just a few minutes. Feel free to grab
                        a ☕ or explore the rest of Kodus.
                    </small>
                </div>
            </div>
        </Page.Root>
    );
}
