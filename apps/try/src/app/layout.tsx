import type { Metadata } from "next";
import { DM_Sans, Overpass_Mono } from "next/font/google";
import { SignupGateProvider } from "@/components/SignupGate";
import "./globals.css";

const dmSans = DM_Sans({
    subsets: ["latin"],
    variable: "--font-dm-sans",
    display: "swap",
});

const overpassMono = Overpass_Mono({
    subsets: ["latin"],
    variable: "--font-overpass-mono",
    display: "swap",
});

export const metadata: Metadata = {
    title: {
        default: "Try Kodus — code review on any GitHub PR",
        template: "%s · Kodus",
    },
    description:
        "Paste any public GitHub PR URL and get an instant AI code review. No signup required.",
    metadataBase: new URL("https://try.kodus.io"),
    robots: { index: true, follow: true },
    openGraph: {
        type: "website",
        siteName: "Kodus",
        title: "Try Kodus — code review on any GitHub PR",
        description:
            "Paste any public GitHub PR URL and get an instant AI code review. No signup required.",
        url: "https://try.kodus.io",
    },
    twitter: {
        card: "summary_large_image",
        title: "Try Kodus — code review on any GitHub PR",
        description:
            "Paste any public GitHub PR URL and get an instant AI code review. No signup required.",
    },
    icons: { icon: "/favicon.ico" },
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html
            lang="en"
            className={`${dmSans.variable} ${overpassMono.variable}`}
        >
            <body className="min-h-screen relative">
                <SignupGateProvider>
                    <div className="relative z-[1]">{children}</div>
                </SignupGateProvider>
            </body>
        </html>
    );
}
