import type { ReactNode } from "react";
import type { Metadata } from "next";

export const metadata: Metadata = {
    title: "Deep scan",
    openGraph: { title: "Deep scan" },
};

export default function DeepScanLayout(props: { children: ReactNode }) {
    return props.children;
}
