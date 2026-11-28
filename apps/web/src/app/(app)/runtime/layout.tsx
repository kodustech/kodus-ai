import type { PropsWithChildren } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isKodyRuntimeReleased } from "src/core/feature-gate/kody-runtime";

export const metadata: Metadata = {
    title: "Kody Runtime",
    openGraph: { title: "Kody Runtime" },
};

/** Kody Runtime is an alpha: an org it is not released to finds no route here. */
export default async function RuntimeLayout(props: PropsWithChildren) {
    if (!(await isKodyRuntimeReleased())) notFound();
    return (
        <div className="flex flex-1 flex-row overflow-hidden">
            {props.children}
        </div>
    );
}
