"use client";

import { createContext, Suspense, useContext, useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { NAV_LAYOUT_COOKIE, type NavLayout } from "./nav-layout-cookie";

const NavLayoutContext = createContext<NavLayout>("top");

export const NavLayoutProvider = ({
    value,
    children,
}: React.PropsWithChildren<{ value: NavLayout }>) => (
    <NavLayoutContext.Provider value={value}>
        <Suspense fallback={null}>
            <NavLayoutQueryParam current={value} />
        </Suspense>
        {children}
    </NavLayoutContext.Provider>
);

export const useNavLayout = () => useContext(NavLayoutContext);

const writeNavLayoutCookie = (layout: NavLayout) => {
    document.cookie = `${NAV_LAYOUT_COOKIE}=${layout}; path=/; max-age=31536000; samesite=lax`;
};

/** Switches the shell; the server re-renders the layout with the new one. */
export const useSetNavLayout = () => {
    const router = useRouter();
    return (layout: NavLayout) => {
        writeNavLayoutCookie(layout);
        router.refresh();
    };
};

/** Applies `?nav=` once, then drops it from the address bar. */
const NavLayoutQueryParam = ({ current }: { current: NavLayout }) => {
    const searchParams = useSearchParams();
    const pathname = usePathname();
    const router = useRouter();
    const requested = searchParams.get("nav");

    useEffect(() => {
        if (requested !== "sidebar" && requested !== "top") return;

        const rest = new URLSearchParams(searchParams.toString());
        rest.delete("nav");
        const query = rest.toString();
        const url = `${pathname}${query ? `?${query}` : ""}`;

        if (requested === current) {
            router.replace(url);
            return;
        }
        writeNavLayoutCookie(requested);
        router.replace(url);
        router.refresh();
    }, [requested, current, pathname, router, searchParams]);

    return null;
};
