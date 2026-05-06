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
function toMessage(err, fallback) {
    if (err instanceof Error && err.message)
        return err.message;
    if (typeof err === "string" && err)
        return err;
    if (err && typeof err === "object") {
        const anyErr = err;
        if (anyErr.message)
            return anyErr.message;
        // img.onerror receives an Event — surface something useful.
        if (anyErr.type === "error" && anyErr.target?.src) {
            return `Failed to load resource: ${anyErr.target.src.slice(0, 80)}`;
        }
        try {
            return JSON.stringify(err).slice(0, 200) || fallback;
        }
        catch {
            return fallback;
        }
    }
    return fallback;
}
function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function copyBlobToClipboard(blob) {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
        return { ok: false, reason: "Clipboard API unavailable (need secure context)" };
    }
    try {
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        return { ok: true };
    }
    catch (err) {
        return { ok: false, reason: toMessage(err, "Clipboard write blocked") };
    }
}
function buildFilename(label) {
    const clean = label.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    return `${clean || "pinsource"}-${stamp}.png`;
}
// 1x1 transparent PNG — substituted for images that fail to fetch so the whole
// capture doesn't reject.
const TRANSPARENT_PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
/**
 * Pinsource's own overlay nodes must never end up in the capture.
 * Callers may also want to drop <img>/<iframe>/<video>/<canvas> as a last
 * resort when external resources are tainting the render.
 */
function baseFilter(node) {
    if (!(node instanceof HTMLElement))
        return true;
    if (node.hasAttribute?.("data-pinsource"))
        return false;
    if (node.id === "pinsource-highlight")
        return false;
    return true;
}
function stripMediaFilter(node) {
    if (!baseFilter(node))
        return false;
    if (!(node instanceof HTMLElement))
        return true;
    const tag = node.tagName;
    if (tag === "IMG" || tag === "VIDEO" || tag === "IFRAME" || tag === "CANVAS")
        return false;
    return true;
}
async function runAttempt(toBlob, el, attempt, options) {
    try {
        const blob = await toBlob(el, options);
        if (!blob)
            return { blob: null, error: "Empty blob (likely canvas taint)", attempt };
        return { blob, error: null, attempt };
    }
    catch (err) {
        return { blob: null, error: toMessage(err, "capture threw"), attempt };
    }
}
export async function captureElement(el, options = {}) {
    if (!el || !(el instanceof HTMLElement)) {
        return { kind: "error", reason: "No element to capture" };
    }
    if (!el.isConnected) {
        return { kind: "error", reason: "Element is not attached to the DOM" };
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
        return { kind: "error", reason: "Element has zero size" };
    }
    let toBlob;
    try {
        const mod = await import("html-to-image");
        toBlob = mod.toBlob;
    }
    catch (err) {
        return { kind: "error", reason: `Failed to load html-to-image: ${toMessage(err, "import error")}` };
    }
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    // Swallow library-level console.warn noise ("Failed to fetch resource: ...")
    // so it doesn't pollute the user's console during normal captures.
    const originalWarn = console.warn;
    const warnBuffer = [];
    console.warn = (...args) => {
        const msg = args.map((a) => (typeof a === "string" ? a : "")).join(" ");
        if (msg.startsWith("Failed to fetch resource"))
            warnBuffer.push(msg);
        else
            originalWarn.apply(console, args);
    };
    const attempts = [];
    try {
        // Attempt 1: high fidelity.
        attempts.push(await runAttempt(toBlob, el, "full", {
            cacheBust: true,
            pixelRatio,
            filter: baseFilter,
        }));
        if (attempts[0].blob)
            return finish(attempts[0].blob);
        // Attempt 2: skip fonts (font fetches often fail on locked-down CSPs),
        // replace broken images with a transparent 1x1.
        attempts.push(await runAttempt(toBlob, el, "skip-fonts", {
            cacheBust: true,
            pixelRatio,
            skipFonts: true,
            imagePlaceholder: TRANSPARENT_PX,
            filter: baseFilter,
        }));
        if (attempts[1].blob)
            return finish(attempts[1].blob);
        // Attempt 3: drop all media (img/video/iframe/canvas). This cannot taint
        // the canvas and avoids every cross-origin pitfall. Layout is preserved.
        attempts.push(await runAttempt(toBlob, el, "no-media", {
            cacheBust: true,
            pixelRatio,
            skipFonts: true,
            filter: stripMediaFilter,
        }));
        if (attempts[2].blob)
            return finish(attempts[2].blob);
        const detail = attempts
            .map((a) => `${a.attempt}: ${a.error}`)
            .join(" | ");
        return { kind: "error", reason: `All capture strategies failed — ${detail}` };
    }
    finally {
        console.warn = originalWarn;
    }
    async function finish(blob) {
        const filename = buildFilename(options.label ?? "element");
        if (!options.forceDownload) {
            const copyResult = await copyBlobToClipboard(blob);
            if (copyResult.ok)
                return { kind: "copied" };
            // Fall through to download on clipboard failure.
        }
        try {
            downloadBlob(blob, filename);
            return { kind: "downloaded", filename };
        }
        catch (err) {
            return { kind: "error", reason: toMessage(err, "Download failed") };
        }
    }
}
//# sourceMappingURL=screenshot.js.map