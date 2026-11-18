import type { ReactNode } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { isDeepScanEnabled } from "../_helpers/get-layout-data";

export const metadata: Metadata = {
    title: "Deep scan",
    openGraph: { title: "Deep scan" },
};

export default async function DeepScanLayout(props: { children: ReactNode }) {
    // Private alpha: outside it the page does not exist.
    if (!(await isDeepScanEnabled().catch(() => false))) {
        notFound();
    }
    return props.children;
}
