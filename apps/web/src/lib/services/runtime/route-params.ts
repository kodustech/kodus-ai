/**
 * A dynamic segment as the API knows it. Next hands the segment still
 * percent-encoded in some cases; a malformed escape ("%E0%A4") must not
 * throw a URIError into the error boundary, so it is passed on as it came.
 */
export const decodeRouteParam = (value: string) => {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
};
