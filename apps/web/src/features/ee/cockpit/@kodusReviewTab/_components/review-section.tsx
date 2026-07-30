import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from "@components/ui/card";
import { cn } from "src/core/utils/components";

export const ReviewSection = ({
    title,
    description,
    footer,
    className,
    children,
}: React.PropsWithChildren & {
    title: string;
    description?: string;
    footer?: string;
    className?: string;
}) => (
    <Card color="lv1" className={cn("h-full", className)}>
        <CardHeader>
            <CardTitle className="text-sm">{title}</CardTitle>
            {description && (
                <CardDescription className="text-xs">
                    {description}
                </CardDescription>
            )}
        </CardHeader>
        <CardContent>{children}</CardContent>
        {footer && (
            <CardFooter className="text-text-tertiary text-xs">
                {footer}
            </CardFooter>
        )}
    </Card>
);
