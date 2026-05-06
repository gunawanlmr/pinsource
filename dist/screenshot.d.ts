/**
 * Capture an HTMLElement as a PNG and either copy to clipboard or download.
 *
 * `html-to-image` works by serializing the element into an SVG `<foreignObject>`,
 * rasterizing it via an `<img>`, and drawing to a canvas. That pipeline is
 * fragile: a single cross-origin image, a blob: URL, a broken font fetch, or
 * a canvas taint will throw with a useless message (often no message at all,
 * because `img.onerror` is an Event, not an Error).
 *
 * Strategy here is layered, fail-soft:
 *   1. Try full-fidelity capture (fonts embedded, images inlined).
 *   2. On failure, retry with `skipFonts` + `imagePlaceholder` (renders broken
 *      images as transparent instead of rejecting).
 *   3. On failure, retry ignoring all <img>/<video>/<iframe>/<canvas> nodes
 *      via the `filter` option — gives a text-accurate capture.
 *   4. If clipboard write fails (permission, insecure context), fall back to
 *      triggering a file download.
 */
export type ScreenshotResult = {
    kind: "copied";
} | {
    kind: "downloaded";
    filename: string;
} | {
    kind: "error";
    reason: string;
};
export declare function captureElement(el: HTMLElement, options?: {
    label?: string;
    forceDownload?: boolean;
}): Promise<ScreenshotResult>;
//# sourceMappingURL=screenshot.d.ts.map