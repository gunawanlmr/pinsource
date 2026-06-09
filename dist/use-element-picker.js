"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveComponentFile, resolvePageFile } from "./resolver";
const DEFAULT_SKIP = new Set([
    "Fragment", "Suspense", "Provider", "Consumer", "StrictMode", "Profiler",
    "ErrorBoundary", "ComponentErrorBoundary",
    "InnerLayoutRouter", "RenderFromTemplateContext", "ScrollAndFocusHandler",
    "InnerScrollAndFocusHandler", "ClientPageRoot", "ClientSegmentRoot",
    "LayoutRouter", "RootLayout", "HotReload", "ReactDevOverlay",
    "PathnameContextProviderAdapter", "AppRouter", "Router",
    "ThemeProvider", "QueryProvider", "JotaiProvider",
]);
const WRAPPER_PATTERNS = /Boundary|Wrapper|Provider|Layout|Context|Fallback|Guard|Gate|Handler|Manager|Loader|Inner$/;
/**
 * Unwrap React.memo / forwardRef / lazy / HOC wrappers to find the underlying
 * component, so that displayName/name reflects the real definition.
 */
function unwrapType(type) {
    if (!type)
        return type;
    let current = type;
    // React.memo: { $$typeof: Symbol(react.memo), type: <inner> }
    // React.forwardRef: { $$typeof: Symbol(react.forward_ref), render: <fn> }
    // React.lazy: { $$typeof: Symbol(react.lazy), _payload, _init }
    for (let i = 0; i < 8; i++) {
        const obj = current;
        if (!obj || typeof obj !== "object")
            break;
        if (typeof obj.type === "object" || typeof obj.type === "function") {
            current = obj.type;
            continue;
        }
        if (typeof obj.render === "function") {
            current = obj.render;
            continue;
        }
        if (obj._payload && typeof obj._payload._result !== "undefined") {
            current = obj._payload._result;
            continue;
        }
        break;
    }
    return current;
}
function getComponentName(fiber) {
    if (!fiber)
        return "";
    const raw = fiber.elementType ?? fiber.type;
    if (!raw)
        return "";
    if (typeof raw === "string")
        return "";
    const t = raw;
    if (t.displayName)
        return t.displayName;
    if (t.name)
        return t.name;
    const inner = unwrapType(raw);
    return inner?.displayName || inner?.name || "";
}
/**
 * Format a Babel debug source into a "path:line" string, stripping absolute
 * project prefixes so the output is the same as what the grep resolver
 * returns (project-relative).
 *
 * Previously this trimmed at the *first* occurrence of a marker directory
 * like `/app/` or `/src/` — which is wrong when the absolute path itself
 * contains one of those names (e.g. `/Users/me/app-projects/site/src/X.tsx`
 * would be mis-trimmed at the leading `/app-`). We now trim at the *last*
 * occurrence, which is the one closest to the file — guaranteed to be the
 * real project-relative boundary.
 */
function formatDebugSource(src) {
    if (!src.fileName)
        return "";
    let file = src.fileName;
    file = file.replace(/^webpack-internal:\/\/\/(?:\(.*?\)\/)?/, "");
    file = file.replace(/^\(turbopack\)\//, "");
    file = file.replace(/^rsc:\/\//, "");
    file = file.replace(/^file:\/\//, "");
    // Find the *last* occurrence of any project-root marker. Using lastIndexOf
    // rather than indexOf means the stripping survives paths that embed a
    // marker name elsewhere (e.g. usernames, monorepo parent dirs).
    const markers = ["/app/", "/components/", "/handlers/", "/lib/", "/src/", "/pages/", "/hooks/", "/utils/", "/features/"];
    let bestIdx = -1;
    for (const m of markers) {
        const idx = file.lastIndexOf(m);
        if (idx > bestIdx)
            bestIdx = idx;
    }
    if (bestIdx > 0)
        file = file.slice(bestIdx + 1);
    // Strip any remaining leading absolute-path noise by dropping everything
    // before the first `./` if present (esbuild, some webpack configs).
    file = file.replace(/^.*?[?&]?file=/, "");
    file = file.replace(/\?.*$/, ""); // drop querystrings like `?t=123`
    return src.lineNumber ? `${file}:${src.lineNumber}` : file;
}
/**
 * Collapse a list of file:line strings — sometimes the fiber chain surfaces
 * the same file twice (host element + its component). Keep the first
 * occurrence only.
 */
function isLikelyProjectFile(file) {
    if (!file)
        return false;
    if (file.includes("/node_modules/"))
        return false;
    if (file.startsWith("node:"))
        return false;
    if (file.includes("react-dom"))
        return false;
    if (file.includes("next/dist/"))
        return false;
    return true;
}
function getDebugSource(fiber) {
    if (!fiber)
        return null;
    if (fiber._debugSource?.fileName)
        return fiber._debugSource;
    return null;
}
function getFiberFromElement(el) {
    const fiberKey = Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    if (!fiberKey)
        return null;
    return el[fiberKey] ?? null;
}
/**
 * Walk the fiber ancestor chain and collect each meaningful component along with
 * its embedded Babel debug source (if the bundler injected it, which is the case
 * for Next.js dev, Vite dev, CRA dev, etc.).
 */
function collectFiberComponents(el, skip) {
    const out = [];
    try {
        let fiber = getFiberFromElement(el);
        for (let depth = 0; depth < 80 && fiber; depth++) {
            const name = getComponentName(fiber);
            if (name && !name.startsWith("_") && !skip.has(name) && name.length > 1) {
                if (out.length === 0 || out[out.length - 1].name !== name) {
                    out.push({ name, debugSource: getDebugSource(fiber) });
                }
                else if (!out[out.length - 1].debugSource) {
                    // Fill in source if the later occurrence has it and the earlier didn't.
                    const existing = getDebugSource(fiber);
                    if (existing)
                        out[out.length - 1].debugSource = existing;
                }
            }
            fiber = fiber.return ?? null;
        }
    }
    catch {
        // ignore
    }
    return out;
}
/**
 * Heuristics for "where is this actually from?" when a click lands on a
 * deeply-nested atomic primitive (e.g. `<TableCell />` inside a
 * `LeaderboardTable` inside a page).
 *
 * Returning just the atomic source is technically correct but unhelpful —
 * users want the *composing* component (the one that assembles the primitive
 * into a real UI surface). We score each candidate and return them sorted so
 * the caller can pick the best, or show both.
 *
 * Score signals (higher is more app-level, lower is more primitive):
 *   +20 path contains `/app/`, `/pages/` (Next app or pages route file)
 *   +12 path contains `/features/`, `/screens/`, `/sections/`
 *   +8  path matches the current page route segment
 *   +6  file name ends in `Page.tsx`, `Screen.tsx`, `Section.tsx`, `View.tsx`
 *   +2  component name equals file basename (canonical component file)
 *   -15 path contains `/components/ui/`, `/components/primitives/`, `/ui/`
 *   -10 path contains `/node_modules/`
 *   -5  file name is a single generic word (Button, Card, Input, etc.)
 */
const ATOMIC_NAMES = new Set([
    "Button", "Input", "Label", "Badge", "Avatar", "Icon", "Card", "Chip",
    "Tag", "Pill", "Switch", "Checkbox", "Radio", "Select", "Textarea",
    "Slider", "Tooltip", "Popover", "Dialog", "Modal", "Sheet", "Drawer",
    "Tabs", "Tab", "Accordion", "AccordionItem", "Table", "TableRow",
    "TableCell", "TableHeader", "TableBody", "Th", "Td", "Tr",
    "Separator", "Divider", "Spinner", "Skeleton", "Progress",
    "Image", "Link", "Text", "Heading", "Paragraph",
]);
function scoreSource(name, file, currentRoute) {
    let score = 0;
    const lower = file.toLowerCase();
    if (lower.includes("/app/") || lower.includes("/pages/"))
        score += 20;
    if (lower.includes("/features/") || lower.includes("/screens/") || lower.includes("/sections/"))
        score += 12;
    if (currentRoute) {
        const firstSeg = currentRoute.split("/").filter(Boolean)[0];
        if (firstSeg && lower.includes(`/${firstSeg}/`))
            score += 8;
    }
    if (/(?:Page|Screen|Section|View)\.[tj]sx?$/i.test(file))
        score += 6;
    const basename = file.split("/").pop()?.replace(/\.[tj]sx?$/, "") || "";
    if (basename && basename === name)
        score += 2;
    if (lower.includes("/components/ui/") || lower.includes("/components/primitives/") || /\/ui\//.test(lower))
        score -= 15;
    if (lower.includes("/node_modules/"))
        score -= 10;
    if (ATOMIC_NAMES.has(name))
        score -= 5;
    return score;
}
/**
 * Collect every (name, source) candidate along the fiber ancestor chain and
 * score them by how "page-level" they are. Returns the best primary match
 * plus every other candidate, sorted desc.
 *
 * The list is the real value — even when `primary` is picked wrong, the
 * caller can offer the user a jumplist of "this → containing component →
 * page" for context.
 */
function collectSourceCandidates(el, skip, currentRoute) {
    const out = [];
    const seen = new Set();
    const pushCandidate = (name, src) => {
        if (!src)
            return;
        const file = formatDebugSource(src);
        if (!file || !isLikelyProjectFile(file))
            return;
        const key = `${name}|${file}`;
        if (seen.has(key))
            return;
        seen.add(key);
        out.push({ name, file, score: scoreSource(name, file, currentRoute) });
    };
    try {
        let fiber = getFiberFromElement(el);
        // The host fiber's own _debugSource is the exact JSX site of the clicked
        // element. Its _debugOwner is the component that rendered that JSX — we
        // surface both.
        if (fiber?._debugSource)
            pushCandidate("(clicked)", fiber._debugSource);
        if (fiber?._debugOwner?._debugSource) {
            const ownerName = getComponentName(fiber._debugOwner) || "(owner)";
            pushCandidate(ownerName, fiber._debugOwner._debugSource);
        }
        for (let depth = 0; depth < 80 && fiber; depth++) {
            const name = getComponentName(fiber);
            if (name && !name.startsWith("_") && !skip.has(name) && name.length > 1) {
                pushCandidate(name, fiber._debugSource);
                if (fiber._debugOwner?._debugSource) {
                    const ownerName = getComponentName(fiber._debugOwner) || "";
                    if (ownerName && !skip.has(ownerName)) {
                        pushCandidate(ownerName, fiber._debugOwner._debugSource);
                    }
                }
            }
            fiber = fiber.return ?? null;
        }
    }
    catch {
        // ignore
    }
    return out.sort((a, b) => b.score - a.score);
}
function getReactSourceLabel(names) {
    if (names.length === 0)
        return "";
    const best = names.find((n) => !WRAPPER_PATTERNS.test(n)) || names[0];
    return `<${best} />`;
}
const NON_VISUAL_TAGS = new Set(["script", "style", "noscript", "head", "meta", "link", "title", "template"]);
/** Marker written to `sourceFile` when resolution completes but finds nothing. */
export const UNRESOLVED_SENTINEL = "__pinsource_unresolved__";
/** Tags/attrs that anchor a DOM path to something an agent can reason about. */
const SEMANTIC_TAGS = new Set([
    "main", "nav", "header", "footer", "aside", "section", "article",
    "form", "table", "ul", "ol", "dialog", "button", "a", "input",
]);
function isSemanticAnchor(el) {
    return (!!el.id ||
        el.hasAttribute("role") ||
        el.hasAttribute("data-testid") ||
        SEMANTIC_TAGS.has(el.tagName.toLowerCase()));
}
function selectorFor(el) {
    let selector = el.tagName.toLowerCase();
    if (el.id) {
        selector += `#${el.id}`;
    }
    else if (typeof el.className === "string") {
        const firstClass = el.className.trim().split(/\s+/)[0];
        if (firstClass && !firstClass.startsWith("__"))
            selector += `.${firstClass}`;
    }
    return selector;
}
/**
 * Compact DOM path: keeps the clicked leaf plus semantic ancestors
 * (landmarks, ids, roles, interactive/structural tags) and collapses runs
 * of plain wrapper `<div>`s to a single `…`. A deeply-nested utility-class
 * chain like `div.no-scrollbar > div.flex > div.relative > button` carries
 * almost no locating signal, so we drop it and keep what an agent can use.
 */
function getElementPath(el) {
    const parts = [];
    let current = el;
    let collapsed = false;
    let first = true;
    while (current && current !== document.body) {
        // Always keep the leaf; keep ancestors only when semantically meaningful.
        if (first || isSemanticAnchor(current)) {
            parts.unshift(selectorFor(current));
            collapsed = false;
        }
        else if (!collapsed) {
            parts.unshift("…");
            collapsed = true;
        }
        first = false;
        current = current.parentElement;
    }
    return parts.join(" > ");
}
function getKeyStyles(el) {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const s = {};
    s["size"] = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
    if (cs.display !== "block")
        s["display"] = cs.display;
    if (cs.display.includes("flex") && cs.flexDirection)
        s["direction"] = cs.flexDirection;
    if (cs.gap && cs.gap !== "normal" && cs.gap !== "0px")
        s["gap"] = cs.gap;
    if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)")
        s["background"] = cs.backgroundColor;
    if (cs.color)
        s["color"] = cs.color;
    if (cs.fontSize)
        s["font-size"] = cs.fontSize;
    if (cs.fontWeight && cs.fontWeight !== "400")
        s["font-weight"] = cs.fontWeight;
    if (cs.padding && cs.padding !== "0px")
        s["padding"] = cs.padding;
    if (cs.borderRadius && cs.borderRadius !== "0px")
        s["border-radius"] = cs.borderRadius;
    return s;
}
const EMPTY_STATE = {
    active: false,
    hoveredSelector: "",
    selectedElement: null,
    elementPath: "",
    componentLabel: "",
    componentChain: [],
    sourceFile: "",
    sourceCandidates: [],
    pageRoute: "",
    pageFile: "",
    tag: "",
    styles: {},
};
export function useElementPicker(options = {}) {
    const { serverUrl, skipComponents } = options;
    const skipSet = useRef(new Set([...DEFAULT_SKIP, ...(skipComponents ?? [])]));
    const [state, setState] = useState(EMPTY_STATE);
    const highlightRef = useRef(null);
    const activeRef = useRef(false);
    const getHighlight = useCallback(() => {
        if (highlightRef.current)
            return highlightRef.current;
        const div = document.createElement("div");
        div.id = "pinsource-highlight";
        div.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 2147483646;
      border: 1px solid rgba(255, 95, 87, 0.8);
      background: rgba(255, 95, 87, 0.08);
      transition: all 0.06s ease-out;
      display: none;
    `;
        document.body.appendChild(div);
        highlightRef.current = div;
        return div;
    }, []);
    const isInsideDevtools = (el) => !!el.closest("[data-pinsource]");
    const handleMouseMove = useCallback((e) => {
        if (!activeRef.current)
            return;
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || NON_VISUAL_TAGS.has(el.tagName.toLowerCase()) || isInsideDevtools(el))
            return;
        const rect = el.getBoundingClientRect();
        const h = getHighlight();
        h.style.display = "block";
        h.style.left = `${rect.left}px`;
        h.style.top = `${rect.top}px`;
        h.style.width = `${rect.width}px`;
        h.style.height = `${rect.height}px`;
        setState((s) => ({ ...s, hoveredSelector: getElementPath(el) }));
    }, [getHighlight]);
    const handleClick = useCallback((e) => {
        if (!activeRef.current)
            return;
        e.preventDefault();
        e.stopPropagation();
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || isInsideDevtools(el))
            return;
        const components = collectFiberComponents(el, skipSet.current);
        const names = components.map((c) => c.name);
        const route = window.location.pathname;
        // Collect every usable source along the chain and score them — the best
        // one (highest-level, page-aware, not an atomic primitive) becomes
        // `sourceFile`. Atomic matches like `components/ui/table.tsx:71` still
        // appear in `sourceCandidates` so the consumer can render the full chain.
        const candidates = collectSourceCandidates(el, skipSet.current, route);
        const best = candidates[0];
        const debugFile = best?.file || "";
        setState({
            ...EMPTY_STATE,
            selectedElement: el,
            elementPath: getElementPath(el),
            componentLabel: getReactSourceLabel(names),
            componentChain: names,
            sourceFile: debugFile,
            sourceCandidates: candidates,
            pageRoute: route,
            tag: el.tagName.toLowerCase(),
            styles: getKeyStyles(el),
            active: false,
            hoveredSelector: "",
        });
        (async () => {
            // Grep fallback for any component name that didn't get a debug source.
            // We *augment* the candidate list rather than replacing it.
            if (candidates.length === 0) {
                const ordered = [
                    ...components.filter((c) => !WRAPPER_PATTERNS.test(c.name)),
                    ...components.filter((c) => WRAPPER_PATTERNS.test(c.name)),
                ];
                const resolved = [];
                for (const comp of ordered) {
                    const file = await resolveComponentFile(comp.name, serverUrl);
                    if (file && isLikelyProjectFile(file)) {
                        resolved.push({ name: comp.name, file, score: scoreSource(comp.name, file, route) });
                    }
                }
                resolved.sort((a, b) => b.score - a.score);
                const bestGrep = resolved[0];
                setState((s) => ({
                    ...s,
                    sourceFile: bestGrep?.file || UNRESOLVED_SENTINEL,
                    sourceCandidates: resolved,
                }));
            }
            if (route) {
                const pf = await resolvePageFile(route, serverUrl);
                setState((s) => ({ ...s, pageFile: pf || s.pageFile }));
            }
        })();
        activeRef.current = false;
        getHighlight().style.display = "none";
    }, [getHighlight, serverUrl]);
    const handleKeyDown = useCallback((e) => {
        if (e.key === "Escape" && activeRef.current) {
            activeRef.current = false;
            setState((s) => ({ ...s, active: false }));
            getHighlight().style.display = "none";
        }
    }, [getHighlight]);
    const togglePicker = useCallback(() => {
        const newActive = !activeRef.current;
        activeRef.current = newActive;
        setState((s) => ({ ...s, active: newActive, ...(newActive ? {} : { hoveredSelector: "" }) }));
        if (!newActive)
            getHighlight().style.display = "none";
    }, [getHighlight]);
    useEffect(() => {
        if (!state.active)
            return;
        document.addEventListener("mousemove", handleMouseMove, true);
        document.addEventListener("click", handleClick, true);
        document.addEventListener("keydown", handleKeyDown, true);
        return () => {
            document.removeEventListener("mousemove", handleMouseMove, true);
            document.removeEventListener("click", handleClick, true);
            document.removeEventListener("keydown", handleKeyDown, true);
        };
    }, [state.active, handleMouseMove, handleClick, handleKeyDown]);
    useEffect(() => {
        return () => {
            if (highlightRef.current) {
                highlightRef.current.remove();
                highlightRef.current = null;
            }
        };
    }, []);
    const clearSelection = useCallback(() => setState(EMPTY_STATE), []);
    return { ...state, togglePicker, clearSelection };
}
//# sourceMappingURL=use-element-picker.js.map