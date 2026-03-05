import { Image } from "@components/ui/image";

export const CockpitNoDataBanner = () => {
    return (
        <div className="bg-warning/10 -mt-10 mb-8 flex min-h-16 items-center justify-center">
            <div className="relative container flex w-full max-w-(--breakpoint-lg) items-center">
                <div className="absolute -bottom-6.5 left-8 max-w-16 scale-x-[-1]">
                    <Image src="/assets/images/kody/look-left-with-paws.png" />
                </div>

                <span className="flex-1 text-center text-sm">
                    <strong>
                        Kody doesn't have enough data yet to fill your cockpit.
                    </strong>{" "}
                    Start by opening a few PRs, and watch the magic happen.
                </span>
            </div>
        </div>
    );
};
