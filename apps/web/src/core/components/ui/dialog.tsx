"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "src/core/utils/components";

import { Button } from "./button";
import { useMagicModalState } from "./magic-modal";

const Dialog = (
    props: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>,
) => {
    const { closeable } = useMagicModalState();

    return (
        <DialogPrimitive.Root
            {...props}
            onOpenChange={(open) => {
                if (!closeable) return;
                props.onOpenChange?.(open);
            }}
        />
    );
};

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = React.forwardRef<
    React.ComponentRef<typeof DialogPrimitive.Close>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>
>((props, ref) => <DialogPrimitive.Close asChild ref={ref} {...props} />);
DialogClose.displayName = DialogPrimitive.Close.displayName;

const DialogOverlay = React.forwardRef<
    React.ComponentRef<typeof DialogPrimitive.Overlay>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
    <DialogPrimitive.Overlay
        data-slot="dialog-overlay"
        ref={ref}
        className={cn(
            "bg-background/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 duration-150 motion-reduce:animate-none!",
            className,
        )}
        {...props}
    />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
    React.ComponentRef<typeof DialogPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => {
    const { closeable } = useMagicModalState();

    return (
        <DialogPortal>
            <DialogOverlay />

            <DialogPrimitive.Content
                data-slot="dialog-content"
                ref={ref}
                className={cn(
                    "bg-background border-card-lv2 fixed flex-col gap-4 border-1 p-6 shadow-xl transition-none duration-150 will-change-transform motion-reduce:animate-none!",
                    "top-[50%] left-[50%] z-50 flex max-h-[calc(100vh-3rem)] w-full max-w-(--breakpoint-sm) translate-x-[-50%] translate-y-[-50%]",
                    "overflow-y-auto",
                    "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
                    "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 sm:rounded-2xl",
                    className,
                )}
                {...props}>
                {children}

                {closeable && (
                    <DialogPrimitive.Close
                        asChild
                        className="absolute top-5 right-4">
                        <Button size="icon-sm" variant="cancel" type="button">
                            <X />
                        </Button>
                    </DialogPrimitive.Close>
                )}
            </DialogPrimitive.Content>
        </DialogPortal>
    );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
    <div
        className={cn(
            "flex flex-col justify-center gap-y-0.5 pr-8 text-center sm:text-left",
            className,
        )}
        {...props}
    />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
    <div
        className={cn("mt-4 flex flex-row justify-end gap-x-2", className)}
        {...props}
    />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
    React.ComponentRef<typeof DialogPrimitive.Title>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
    <DialogPrimitive.Title
        ref={ref}
        className={cn(
            "text-lg leading-tight font-semibold tracking-tight",
            className,
        )}
        {...props}
    />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
    React.ComponentRef<typeof DialogPrimitive.Description>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
    <DialogPrimitive.Description
        ref={ref}
        className={cn(
            "text-text-secondary mt-1 text-sm leading-tight",
            className,
        )}
        {...props}
    />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogOverlay,
    DialogPortal,
    DialogTitle,
    DialogTrigger,
};
