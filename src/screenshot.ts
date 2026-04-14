/**
 * Capture an HTMLElement as a PNG and either copy to clipboard or download.
 *
 * Strategy:
 *   1. Render the element via `html-to-image` (loaded lazily — keeps the
 *      main bundle small when screenshotting isn't used).
 *   2. Try `navigator.clipboard.write` with a PNG `ClipboardItem`. This
 *      works in Chromium, Safari (16+), and Firefox (127+).
 *   3. If clipboard write fails (permission, old browser, non-secure
 *      context), fall back to triggering a file download.
 *
 * Returns a discriminated result so the caller can show an appropriate
 * toast/message.
 */

export type ScreenshotResult =
  | { kind: "copied" }
  | { kind: "downloaded"; filename: string }
  | { kind: "error"; reason: string };

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the download starts so the browser has time to begin fetching.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function copyBlobToClipboard(blob: Blob): Promise<boolean> {
  // ClipboardItem + navigator.clipboard.write is the only way to put an image
  // on the OS clipboard. Requires a secure context (https or localhost).
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    return false;
  }
  try {
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return true;
  } catch {
    return false;
  }
}

function buildFilename(label: string): string {
  const clean = label.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${clean || "pinsource"}-${stamp}.png`;
}

export async function captureElement(
  el: HTMLElement,
  options: { label?: string; forceDownload?: boolean } = {},
): Promise<ScreenshotResult> {
  if (!el || !(el instanceof HTMLElement)) {
    return { kind: "error", reason: "No element to capture" };
  }

  let toBlob: (node: HTMLElement, options?: Record<string, unknown>) => Promise<Blob | null>;
  try {
    const mod = await import("html-to-image");
    toBlob = mod.toBlob as typeof toBlob;
  } catch {
    return { kind: "error", reason: "Failed to load html-to-image" };
  }

  let blob: Blob | null;
  try {
    blob = await toBlob(el, {
      cacheBust: true,
      pixelRatio: window.devicePixelRatio || 2,
      // Exclude the devtools overlay so it doesn't end up in the screenshot.
      filter: (node: Node) => {
        if (!(node instanceof HTMLElement)) return true;
        if (node.hasAttribute?.("data-pinsource")) return false;
        if (node.id === "pinsource-highlight") return false;
        return true;
      },
    });
  } catch (err) {
    return {
      kind: "error",
      reason: err instanceof Error ? err.message : "Capture failed",
    };
  }

  if (!blob) {
    return { kind: "error", reason: "Empty capture" };
  }

  const filename = buildFilename(options.label ?? "element");

  if (!options.forceDownload) {
    const copied = await copyBlobToClipboard(blob);
    if (copied) return { kind: "copied" };
  }

  try {
    downloadBlob(blob, filename);
    return { kind: "downloaded", filename };
  } catch (err) {
    return {
      kind: "error",
      reason: err instanceof Error ? err.message : "Download failed",
    };
  }
}
