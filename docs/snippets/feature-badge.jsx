export const FeatureBadge = ({ id, detail, children }) => {
    const element = useRef(null);
    const [open, setOpen] = useState(false);
    const detailId = `feature-badge-${id}`;

    useEffect(() => {
        if (!open) return;

        const dismissOnOutsidePress = (event) => {
            if (!element.current?.contains(event.target)) setOpen(false);
        };
        const dismissOnEscape = (event) => {
            if (event.key === 'Escape') setOpen(false);
        };

        document.addEventListener('pointerdown', dismissOnOutsidePress);
        document.addEventListener('keydown', dismissOnEscape);
        return () => {
            document.removeEventListener('pointerdown', dismissOnOutsidePress);
            document.removeEventListener('keydown', dismissOnEscape);
        };
    }, [open]);

    return (
        <span
            ref={element}
            onPointerEnter={(event) => {
                if (event.pointerType === 'mouse') setOpen(true);
            }}
            onPointerLeave={(event) => {
                if (event.pointerType === 'mouse') setOpen(false);
            }}
        >
            <button
                type="button"
                aria-expanded={open}
                aria-describedby={detailId}
                onFocus={(event) => {
                    if (event.currentTarget.matches(':focus-visible'))
                        setOpen(true);
                }}
                onBlur={() => setOpen(false)}
                onClick={(event) => {
                    setOpen(
                        (wasOpen) =>
                            event.nativeEvent.pointerType === 'mouse' ||
                            !wasOpen,
                    );
                }}
            >
                {children}
            </button>
            <span
                id={detailId}
                role="tooltip"
                className="kodus-feature-badge-detail"
                hidden={!open}
            >
                {detail}
            </span>
        </span>
    );
};
