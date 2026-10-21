import { Metadata } from "next";
import { notFound } from "next/navigation";

import { PlanStatusGallery } from "./_gallery";

// A review surface for the sidebar's plan panel: every billing state at once,
// which no single organization can show. Not part of the product.
export default function PlanStatusGalleryPage() {
    if (process.env.NODE_ENV === "production") notFound();

    return <PlanStatusGallery />;
}

export const metadata: Metadata = { title: "Plan status gallery" };
