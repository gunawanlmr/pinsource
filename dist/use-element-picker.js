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
function getComponentName(fiber) {
    if (!fiber?.type)
        return "";
    if (typeof fiber.type === "string")
        return "";
    const t = fiber.type;
    return t.displayName || t.name || "";
}
function getReactComponentNames(el, skip) {
    const names = [];
    try {
        const fiberKey = Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
        if (!fiberKey)
            return names;
        let fiber = el[fiberKey];
        for (let depth = 0; depth < 60 && fiber; depth++) {
            const name = getComponentName(fiber);
            if (name && !name.startsWith("_") && !skip.has(name) && name.length > 1) {
                if (names.length === 0 || names[names.length - 1] !== name)
                    names.push(name);
            }
            fiber = fiber.return;
        }
    }
    catch {
        // ignore
    }
    return names;
}
function getReactSourceLabel(names) {
    if (names.length === 0)
        return "";
    const best = names.find((n) => !WRAPPER_PATTERNS.test(n)) || names[0];
    return `<${best} />`;
}
const NON_VISUAL_TAGS = new Set(["script", "style", "noscript", "head", "meta", "link", "title", "template"]);
function getElementPath(el) {
    const parts = [];
    let current = el;
    while (current && current !== document.body) {
        let selector = current.tagName.toLowerCase();
        if (current.id) {
            selector += `#${current.id}`;
        }
        else if (typeof current.className === "string") {
            const firstClass = current.className.trim().split(/\s+/)[0];
            if (firstClass && !firstClass.startsWith("__"))
                selector += `.${firstClass}`;
        }
        parts.unshift(selector);
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
        const names = getReactComponentNames(el, skipSet.current);
        const route = window.location.pathname;
        setState({
            ...EMPTY_STATE,
            selectedElement: el,
            elementPath: getElementPath(el),
            componentLabel: getReactSourceLabel(names),
            componentChain: names,
            pageRoute: route,
            tag: el.tagName.toLowerCase(),
            styles: getKeyStyles(el),
            active: false,
            hoveredSelector: "",
        });
        (async () => {
            const sortedNames = [
                ...names.filter((n) => !WRAPPER_PATTERNS.test(n)),
                ...names.filter((n) => WRAPPER_PATTERNS.test(n)),
            ];
            for (const name of sortedNames) {
                const file = await resolveComponentFile(name, serverUrl);
                if (file) {
                    setState((s) => ({ ...s, sourceFile: file }));
                    break;
                }
            }
            if (route) {
                const pf = await resolvePageFile(route, serverUrl);
                if (pf)
                    setState((s) => ({ ...s, pageFile: pf }));
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