import { Card } from "@components/ui/card";

export default function Layout({ children }: React.PropsWithChildren) {
    return <Card color="lv1" className="h-full">{children}</Card>;
}
