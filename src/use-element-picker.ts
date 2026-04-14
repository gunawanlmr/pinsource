"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { resolveComponentFile, resolvePageFile } from "./resolver";
import type { DevToolsOptions, PickerState } from "./types";

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
function unwrapType(type: unknown): unknown {
  if (!type) return type;
  let current: unknown = type;
  // React.memo: { $$typeof: Symbol(react.memo), type: <inner> }
  // React.forwardRef: { $$typeof: Symbol(react.forward_ref), render: <fn> }
  // React.lazy: { $$typeof: Symbol(react.lazy), _payload, _init }
  for (let i = 0; i < 8; i++) {
    const obj = current as Record<string, unknown> | null | undefined;
    if (!obj || typeof obj !== "object") break;
    if (typeof obj.type === "object" || typeof obj.type === "function") {
      current = obj.type;
      continue;
    }
    if (typeof obj.render === "function") {
      current = obj.render;
      continue;
    }
    if (obj._payload && typeof (obj._payload as { _result?: unknown })._result !== "undefined") {
      current = (obj._payload as { _result: unknown })._result;
      continue;
    }
    break;
  }
  return current;
}

function getComponentName(fiber: { type?: unknown; elementType?: unknown } | null | undefined): string {
  if (!fiber) return "";
  const raw = fiber.elementType ?? fiber.type;
  if (!raw) return "";
  if (typeof raw === "string") return "";
  const t = raw as { displayName?: string; name?: string };
  if (t.displayName) return t.displayName;
  if (t.name) return t.name;
  const inner = unwrapType(raw) as { displayName?: string; name?: string } | null | undefined;
  return inner?.displayName || inner?.name || "";
}

interface DebugSource {
  fileName?: string;
  lineNumber?: number;
  columnNumber?: number;
}

interface FiberLike {
  type?: unknown;
  elementType?: unknown;
  return?: FiberLike | null;
  _debugSource?: DebugSource;
  _debugOwner?: FiberLike | null;
}

/**
 * Format a Babel debug source into a "path:line" string, stripping absolute
 * project prefixes so the output is the same as what the grep resolver
 * returns (project-relative).
 */
function formatDebugSource(src: DebugSource): string {
  if (!src.fileName) return "";
  let file = src.fileName;
  // Common webpack/next prefix: "webpack-internal:///" or "(turbopack)/"
  file = file.replace(/^webpack-internal:\/\/\/(?:\(.*?\)\/)?/, "");
  file = file.replace(/^\(turbopack\)\//, "");
  file = file.replace(/^file:\/\//, "");
  // Strip everything up to and including a `/src/` or project-root-ish marker.
  // Heuristic: if path contains /app/, /components/, /src/, /pages/, trim to that.
  const markers = ["/app/", "/components/", "/handlers/", "/lib/", "/src/", "/pages/"];
  for (const m of markers) {
    const idx = file.indexOf(m);
    if (idx > 0) {
      file = file.slice(idx + 1);
      break;
    }
  }
  return src.lineNumber ? `${file}:${src.lineNumber}` : file;
}

function getDebugSource(fiber: FiberLike | null | undefined): DebugSource | null {
  if (!fiber) return null;
  if (fiber._debugSource?.fileName) return fiber._debugSource;
  return null;
}

function getFiberFromElement(el: HTMLElement): FiberLike | null {
  const fiberKey = Object.keys(el).find(
    (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"),
  );
  if (!fiberKey) return null;
  return (el as unknown as Record<string, FiberLike | undefined>)[fiberKey] ?? null;
}

export interface FiberComponent {
  name: string;
  /** File + line from Babel jsx-dev-runtime / @babel/plugin-transform-react-jsx-source, if available. */
  debugSource: DebugSource | null;
}

/**
 * Walk the fiber ancestor chain and collect each meaningful component along with
 * its embedded Babel debug source (if the bundler injected it, which is the case
 * for Next.js dev, Vite dev, CRA dev, etc.).
 */
function collectFiberComponents(el: HTMLElement, skip: Set<string>): FiberComponent[] {
  const out: FiberComponent[] = [];
  try {
    let fiber: FiberLike | null = getFiberFromElement(el);
    for (let depth = 0; depth < 80 && fiber; depth++) {
      const name = getComponentName(fiber);
      if (name && !name.startsWith("_") && !skip.has(name) && name.length > 1) {
        if (out.length === 0 || out[out.length - 1].name !== name) {
          out.push({ name, debugSource: getDebugSource(fiber) });
        } else if (!out[out.length - 1].debugSource) {
          // Fill in source if the later occurrence has it and the earlier didn't.
          const existing = getDebugSource(fiber);
          if (existing) out[out.length - 1].debugSource = existing;
        }
      }
      fiber = fiber.return ?? null;
    }
  } catch {
    // ignore
  }
  return out;
}

function getReactSourceLabel(names: string[]): string {
  if (names.length === 0) return "";
  const best = names.find((n) => !WRAPPER_PATTERNS.test(n)) || names[0];
  return `<${best} />`;
}

const NON_VISUAL_TAGS = new Set(["script", "style", "noscript", "head", "meta", "link", "title", "template"]);

/** Marker written to `sourceFile` when resolution completes but finds nothing. */
export const UNRESOLVED_SENTINEL = "__pinsource_unresolved__";

function getElementPath(el: HTMLElement): string {
  const parts: string[] = [];
  let current: HTMLElement | null = el;
  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      selector += `#${current.id}`;
    } else if (typeof current.className === "string") {
      const firstClass = current.className.trim().split(/\s+/)[0];
      if (firstClass && !firstClass.startsWith("__")) selector += `.${firstClass}`;
    }
    parts.unshift(selector);
    current = current.parentElement;
  }
  return parts.join(" > ");
}

function getKeyStyles(el: HTMLElement): Record<string, string> {
  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const s: Record<string, string> = {};
  s["size"] = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
  if (cs.display !== "block") s["display"] = cs.display;
  if (cs.display.includes("flex") && cs.flexDirection) s["direction"] = cs.flexDirection;
  if (cs.gap && cs.gap !== "normal" && cs.gap !== "0px") s["gap"] = cs.gap;
  if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)") s["background"] = cs.backgroundColor;
  if (cs.color) s["color"] = cs.color;
  if (cs.fontSize) s["font-size"] = cs.fontSize;
  if (cs.fontWeight && cs.fontWeight !== "400") s["font-weight"] = cs.fontWeight;
  if (cs.padding && cs.padding !== "0px") s["padding"] = cs.padding;
  if (cs.borderRadius && cs.borderRadius !== "0px") s["border-radius"] = cs.borderRadius;
  return s;
}

const EMPTY_STATE: PickerState = {
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

export function useElementPicker(options: DevToolsOptions = {}) {
  const { serverUrl, skipComponents } = options;
  const skipSet = useRef(new Set([...DEFAULT_SKIP, ...(skipComponents ?? [])]));
  const [state, setState] = useState<PickerState>(EMPTY_STATE);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef(false);

  const getHighlight = useCallback(() => {
    if (highlightRef.current) return highlightRef.current;
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

  const isInsideDevtools = (el: HTMLElement) => !!el.closest("[data-pinsource]");

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!activeRef.current) return;
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (!el || NON_VISUAL_TAGS.has(el.tagName.toLowerCase()) || isInsideDevtools(el)) return;
      const rect = el.getBoundingClientRect();
      const h = getHighlight();
      h.style.display = "block";
      h.style.left = `${rect.left}px`;
      h.style.top = `${rect.top}px`;
      h.style.width = `${rect.width}px`;
      h.style.height = `${rect.height}px`;
      setState((s) => ({ ...s, hoveredSelector: getElementPath(el) }));
    },
    [getHighlight],
  );

  const handleClick = useCallback(
    (e: MouseEvent) => {
      if (!activeRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (!el || isInsideDevtools(el)) return;

      const components = collectFiberComponents(el, skipSet.current);
      const names = components.map((c) => c.name);
      const route = window.location.pathname;

      // Prefer the first non-wrapper component as the "primary" hit.
      const primaryIdx = Math.max(
        0,
        components.findIndex((c) => !WRAPPER_PATTERNS.test(c.name)),
      );
      const primary = components[primaryIdx];

      // If Babel injected _debugSource, we already have the exact file + line —
      // no grep needed. This is the most accurate path.
      const debugFile = primary?.debugSource?.fileName
        ? formatDebugSource(primary.debugSource)
        : "";

      setState({
        ...EMPTY_STATE,
        selectedElement: el,
        elementPath: getElementPath(el),
        componentLabel: getReactSourceLabel(names),
        componentChain: names,
        sourceFile: debugFile,
        pageRoute: route,
        tag: el.tagName.toLowerCase(),
        styles: getKeyStyles(el),
        active: false,
        hoveredSelector: "",
      });

      (async () => {
        // If we already have an accurate debug source, skip the grep resolver.
        if (!debugFile) {
          const ordered = [
            ...components.filter((c) => !WRAPPER_PATTERNS.test(c.name)),
            ...components.filter((c) => WRAPPER_PATTERNS.test(c.name)),
          ];
          let resolved = "";
          for (const comp of ordered) {
            if (comp.debugSource?.fileName) {
              resolved = formatDebugSource(comp.debugSource);
              break;
            }
            const file = await resolveComponentFile(comp.name, serverUrl);
            if (file) {
              resolved = file;
              break;
            }
          }
          // Always exit the "resolving…" state, even if nothing was found.
          // Using a sentinel so the UI can render a clear message.
          setState((s) => ({
            ...s,
            sourceFile: resolved || UNRESOLVED_SENTINEL,
          }));
        }
        if (route) {
          const pf = await resolvePageFile(route, serverUrl);
          setState((s) => ({ ...s, pageFile: pf || s.pageFile }));
        }
      })();

      activeRef.current = false;
      getHighlight().style.display = "none";
    },
    [getHighlight, serverUrl],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && activeRef.current) {
        activeRef.current = false;
        setState((s) => ({ ...s, active: false }));
        getHighlight().style.display = "none";
      }
    },
    [getHighlight],
  );

  const togglePicker = useCallback(() => {
    const newActive = !activeRef.current;
    activeRef.current = newActive;
    setState((s) => ({ ...s, active: newActive, ...(newActive ? {} : { hoveredSelector: "" }) }));
    if (!newActive) getHighlight().style.display = "none";
  }, [getHighlight]);

  useEffect(() => {
    if (!state.active) return;
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
