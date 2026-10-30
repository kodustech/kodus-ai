import NextImage from "next/image";
import { cn } from "src/core/utils/components";

export const Image = (
    // `alt` is required on purpose. It used to be optional with a default of
    // "(no description provided)", which a screen reader reads out loud — worse
    // than no image at all. The author has to decide: real text, or `alt=""`
    // when the image is decorative and should be skipped.
    props: React.ComponentProps<typeof NextImage>,
) => {
    const { alt, src, width, height, sizes, className, style, ...otherProps } =
        props;

    return (
        <NextImage
            {...otherProps}
            alt={alt}
            src={src}
            sizes="100vw"
            width={9999}
            height={9999}
            className={cn("pointer-events-none select-none", className)}
            style={{
                ...style,
                width: "100%",
                height: "auto",
            }}
        />
    );
};
