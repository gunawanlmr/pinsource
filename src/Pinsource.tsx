"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { captureElement, type ScreenshotResult } from "./screenshot";
import { isBackendConnected } from "./resolver";
import { UNRESOLVED_SENTINEL, useElementPicker } from "./use-element-picker";
import type { DevToolsOptions, PickedElement } from "./types";

/**
 * Create (once) a host container attached directly to <body> so pinsource is
 * never trapped inside another element's stacking context. Modals from the
 * host app typically portal into <body> too, but because our host mounts
 * *after* any app modal is inserted (and persists), and we also opt into the
 * CSS top-layer via `popover`, we consistently sit above everything.
 *
 * Falls back to null during SSR.
 */
function usePortalHost(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const existing = document.getElementById("pinsource-host");
    if (existing instanceof HTMLElement) {
      setHost(existing);
      return;
    }
    const el = document.createElement("div");
    el.id = "pinsource-host";
    // Top-layer opt-in (Chromium 114+, Safari 17+, Firefox 125+). Any browser
    // that doesn't support `popover` ignores the attribute — we still win on
    // z-index because we're attached to <body>.
    try {
      el.setAttribute("popover", "manual");
    } catch {
      // SVG elements etc. — not relevant for a div, but cheap to guard.
    }
    // Reset styles popover applies (it defaults to inset:0, which would cover
    // the whole page). We want a zero-footprint host that only sizes to its
    // children.
    el.style.position = "fixed";
    el.style.inset = "auto";
    el.style.width = "0";
    el.style.height = "0";
    el.style.margin = "0";
    el.style.padding = "0";
    el.style.border = "0";
    el.style.background = "transparent";
    el.style.overflow = "visible";
    // Host itself is pointer-events: none — individual children re-enable it.
    // This means clicks on the transparent host pass through to the app.
    el.style.pointerEvents = "none";
    document.body.appendChild(el);
    // Show the popover so it enters the top layer. Guarded because the API
    // is new and throws on some engines.
    try {
      (el as unknown as { showPopover?: () => void }).showPopover?.();
    } catch {
      // not in top layer — z-index still keeps us on top in every
      // pre-popover browser.
    }
    setHost(el);
    return () => {
      // Keep the host across re-mounts (StrictMode, fast-refresh). We only
      // remove it if nothing else is using it.
      if (el.childNodes.length === 0) el.remove();
    };
  }, []);

  return host;
}

/**
 * Build an AI-ready prompt block. Claude (or any LLM agent) can paste this
 * directly and immediately act on it:
 *  - explicit `@file:line` references the agent can open
 *  - component chain the agent can grep for if the primary file is wrong
 *  - route + page file so the agent knows which screen this was picked on
 *  - computed styles so visual-fix prompts don't need a screenshot
 */
function formatForCopy(p: PickedElement): string {
  const componentName = p.componentLabel.replace(/[<>/\s]/g, "") || "(unknown)";
  const primary = p.sourceFile
    ? `@${p.sourceFile}`
    : "(source file unresolved — run `npx pinsource init` then `npm run dev`)";
  const page = p.pageFile ? `@${p.pageFile}` : "(unresolved)";

  const refs: string[] = [];
  if (p.sourceFile) refs.push(`- ${primary}  ← best match (composing component)`);
  // Surface every other candidate so the model can jump up/down the tree
  // if the "best" pick happens to be an atomic primitive or a wrapper.
  if (p.sourceCandidates && p.sourceCandidates.length > 1) {
    for (const c of p.sourceCandidates.slice(1, 4)) {
      refs.push(`- @${c.file}  ← ${c.name}`);
    }
  }
  if (p.pageFile) refs.push(`- ${page}  ← page where it was picked`);

  const chain = p.componentChain.length > 0
    ? p.componentChain.map((n, i) => (i === 0 ? `**${n}**` : n)).join(" → ")
    : "(no fiber chain)";

  const stylesBlock = Object.keys(p.styles).length > 0
    ? Object.entries(p.styles).map(([k, v]) => `- ${k}: ${v}`).join("\n")
    : "- (no notable computed styles)";

  return [
    `I picked a UI element in the running app. Here is everything you need to locate and modify it:`,
    ``,
    `**Component:** \`${componentName}\``,
    `**Route:** \`${p.pageRoute || "/"}\``,
    `**DOM tag:** \`<${p.tag || "?"}>\``,
    ``,
    `**File references (open these first):**`,
    refs.length > 0 ? refs.join("\n") : "- (none resolved — grep for the component name below)",
    ``,
    `**Component chain (nearest → outermost):**`,
    chain,
    ``,
    `**DOM path:**`,
    `\`${p.elementPath || "(empty)"}\``,
    ``,
    `**Computed styles:**`,
    stylesBlock,
    ``,
    `**Task:** <describe what to change>`,
    ``,
    `If the primary source file above is missing or wrong, grep the repo for \`${componentName}\` (or the next name in the chain) to locate the definition.`,
  ].join("\n");
}

/** Minimal copy: just the file references, for quick @-mentions in chat. */
/**
 * Compact copy format optimized for LLM parsing.
 *
 * Design principles:
 *  - **Fenced block** — clear start/end so the model doesn't mix it with
 *    surrounding prose in a chat message.
 *  - **Stable key/value pairs** — one field per line, `key: value`, lower-case
 *    keys, no padding. Easy to tokenize; easy for tools to regex.
 *  - **File refs as bare `path:line`** — the format Cursor, VS Code CLI,
 *    Claude Code, and grep-style tools natively understand. No `@` prefix
 *    which confuses some parsers.
 *  - **Ancestor chain included** when useful — gives the model a fallback
 *    grep target if the resolved file turns out to be wrong.
 *  - **Short and deterministic** — every field is a single line; missing
 *    fields are simply omitted (no "(unknown)" placeholders).
 *
 * Example output:
 *
 * ```pinsource
 * component: TableCell
 * tag: td
 * route: /leaderboard
 * source: src/components/ui/table.tsx:71
 * page: app/leaderboard/page.tsx
 * chain: TableCell > TableRow > Table
 * dom: main > div.panel > table > tbody > tr > td.cell
 * ```
 */
function formatCompactCopy(p: PickedElement): string {
  const componentName = p.componentLabel.replace(/[<>/\s]/g, "") || "unknown";
  const fields: string[] = [`component: ${componentName}`];
  if (p.tag && p.tag !== componentName.toLowerCase()) fields.push(`tag: ${p.tag}`);
  if (p.pageRoute) fields.push(`route: ${p.pageRoute}`);

  // "source:" is the best-scored candidate (page-level when possible).
  // "sources:" lists every level — so when the best pick is still too atomic,
  // the consuming LLM can walk up to the composing component itself.
  if (p.sourceFile) fields.push(`source: ${p.sourceFile}`);
  if (p.pageFile) fields.push(`page: ${p.pageFile}`);

  if (p.sourceCandidates && p.sourceCandidates.length > 1) {
    // Cap at 4 to keep the block tight. Already sorted page-level → atomic.
    const rows = p.sourceCandidates
      .slice(0, 4)
      .map((c) => `  - ${c.name}: ${c.file}`);
    fields.push("sources:");
    fields.push(...rows);
  }

  if (p.componentChain.length > 1) {
    fields.push(`chain: ${p.componentChain.slice(0, 5).join(" > ")}`);
  }
  if (p.elementPath) fields.push(`dom: ${p.elementPath}`);
  if (!p.sourceFile && p.componentChain.length > 0) {
    fields.push(`hint: source unresolved — grep for ${p.componentChain[0]}`);
  }
  return ["```pinsource", ...fields, "```"].join("\n");
}

function CopyIcon({ copied, size = 14 }: { copied: boolean; size?: number }) {
  if (copied) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
        <path d="M13 4L6 11L3 8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
      <path d="M11 5V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}

function CrosshairIcon({ active, size = 16 }: { active: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.25" fill={active ? "currentColor" : "none"} />
      <path d="M8 1v3M8 12v3M1 8h3M12 8h3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

function SparkIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M12 3l2.09 5.26L19 10.18l-4.09 2.93L16 18.36 12 15.77 8 18.36l1.09-5.25L5 10.18l4.91-1.92L12 3z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CameraIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="4" width="13" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5 4l1-1.5h4L11 4" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="8" cy="8.5" r="2.5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function CloseIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CollapsibleCard({
  label,
  count,
  defaultOpen = false,
  children,
}: {
  label: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={styles.card}>
      <button
        data-secondary-action
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: 0,
          background: "transparent",
          border: "none",
          color: "#6b7280",
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        <span style={{ color: "#6b7280" }}><ChevronIcon open={open} /></span>
        <span style={{ ...styles.label, marginBottom: 0, flex: 1, textAlign: "left" }}>
          {label}
        </span>
        {typeof count === "number" && (
          <span style={{ fontSize: 10, color: "#6b7280", fontFamily: "ui-monospace, monospace" }}>
            {count}
          </span>
        )}
      </button>
      {open && <div style={{ marginTop: 6 }}>{children}</div>}
    </div>
  );
}

function ChevronIcon({ open, size = 12 }: { open: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      style={{
        transition: "transform 0.15s ease",
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
      }}
    >
      <path d="M4.5 3l3 3-3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DragHandleIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none">
      <circle cx="3" cy="3" r="1" fill="currentColor" />
      <circle cx="9" cy="3" r="1" fill="currentColor" />
      <circle cx="3" cy="6" r="1" fill="currentColor" />
      <circle cx="9" cy="6" r="1" fill="currentColor" />
      <circle cx="3" cy="9" r="1" fill="currentColor" />
      <circle cx="9" cy="9" r="1" fill="currentColor" />
    </svg>
  );
}

const ACCENT = "#ff5f57";
const ACCENT_DEEP = "#e53935";

const styles = {
  root: {
    position: "fixed" as const,
    zIndex: 2147483647,
    // Host container is pointer-events:none so transparent areas pass clicks
    // through to the app. Re-enable on our actual UI so buttons still work.
    pointerEvents: "auto" as const,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    fontSize: 12,
    color: "#e5e7eb",
    display: "flex",
    flexDirection: "column-reverse" as const,
    alignItems: "flex-end",
    gap: 12,
  },
  fab: {
    width: 44,
    height: 44,
    borderRadius: "50%",
    background: `linear-gradient(135deg, ${ACCENT} 0%, ${ACCENT_DEEP} 100%)`,
    border: "none",
    cursor: "pointer",
    boxShadow:
      "0 10px 30px rgba(255, 95, 87, 0.45), 0 2px 6px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.25)",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "transform 0.15s ease, box-shadow 0.15s ease",
    position: "relative" as const,
    outline: "none",
  },
  fabActive: {
    background: "linear-gradient(135deg, #22c55e 0%, #16a34a 100%)",
    boxShadow:
      "0 10px 30px rgba(34,197,94,0.45), 0 2px 6px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.25)",
  },
  fabBadge: {
    position: "absolute" as const,
    top: -2,
    right: -2,
    minWidth: 18,
    height: 18,
    padding: "0 5px",
    borderRadius: 999,
    background: "#ef4444",
    border: "2px solid rgba(17,17,20,1)",
    color: "#fff",
    fontSize: 10,
    fontWeight: 600,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  panel: {
    width: 320,
    maxWidth: "calc(100vw - 24px)",
    maxHeight: "calc(100vh - 88px)",
    display: "flex",
    flexDirection: "column" as const,
    background: "rgba(20,20,24,0.98)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 14,
    boxShadow: "0 24px 64px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.4)",
    backdropFilter: "blur(16px)",
    overflow: "hidden" as const,
    animation: "pinsource-pop 180ms cubic-bezier(0.22, 1, 0.36, 1)",
  },
  panelHeader: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 10px",
    background: "rgba(255,255,255,0.02)",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
    cursor: "grab",
    userSelect: "none" as const,
  },
  panelTitle: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: 0.2,
    flex: 1,
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  panelBody: {
    padding: 10,
    flex: 1,
    minHeight: 0,
    overflowY: "auto" as const,
  },
  panelFooter: {
    flexShrink: 0,
    padding: "8px 10px",
    borderTop: "1px solid rgba(255,255,255,0.06)",
    background: "rgba(255,255,255,0.02)",
  },
  iconButton: {
    width: 26,
    height: 26,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    border: "none",
    borderRadius: 6,
    color: "#9ca3af",
    cursor: "pointer",
    transition: "background 0.12s, color 0.12s",
  },
  primaryAction: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    width: "100%",
    padding: "10px 12px",
    background: `linear-gradient(135deg, ${ACCENT} 0%, ${ACCENT_DEEP} 100%)`,
    border: "none",
    borderRadius: 8,
    color: "#fff",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
    fontFamily: "inherit",
    boxShadow: "0 4px 12px rgba(229,57,53,0.35)",
    transition: "transform 0.12s, box-shadow 0.12s",
  },
  primaryActionActive: {
    background: "linear-gradient(135deg, #22c55e 0%, #16a34a 100%)",
    boxShadow: "0 4px 12px rgba(34,197,94,0.35)",
  },
  secondaryAction: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "8px 10px",
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 7,
    color: "#e5e7eb",
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 500,
    fontFamily: "inherit",
    transition: "background 0.12s",
  },
  secondaryActionSuccess: {
    background: "rgba(34,197,94,0.18)",
    borderColor: "rgba(34,197,94,0.4)",
    color: "#86efac",
  },
  card: {
    background: "rgba(255,255,255,0.02)",
    border: "1px solid rgba(255,255,255,0.06)",
    borderRadius: 8,
    padding: "8px 10px",
    marginBottom: 6,
  },
  label: {
    color: "#6b7280",
    fontSize: 9,
    textTransform: "uppercase" as const,
    letterSpacing: 0.8,
    fontWeight: 600,
    marginBottom: 4,
  },
  valueMono: {
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    fontSize: 11,
    color: "#e5e7eb",
    wordBreak: "break-all" as const,
    lineHeight: 1.45,
  },
  chainRow: {
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    fontSize: 10.5,
    color: "#9ca3af",
    lineHeight: 1.5,
  },
  divider: {
    height: 1,
    background: "rgba(255,255,255,0.06)",
    margin: "6px 0 8px",
  },
  emptyState: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center" as const,
    padding: "28px 20px 20px",
    color: "#9ca3af",
    fontSize: 12,
    lineHeight: 1.5,
  },
  kbd: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 18,
    height: 16,
    padding: "0 5px",
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 4,
    fontSize: 10,
    fontFamily: "ui-monospace, monospace",
    color: "#d1d5db",
    lineHeight: 1,
  },
};

interface DevToolsProps extends DevToolsOptions {
  /** Default panel corner. Default: "bottom-right" */
  defaultCorner?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
}

function cornerToPos(corner: DevToolsProps["defaultCorner"]) {
  switch (corner) {
    case "top-right":
      return { top: 16, right: 16 };
    case "bottom-left":
      return { bottom: 16, left: 16 };
    case "bottom-right":
      return { bottom: 16, right: 16 };
    default:
      return { top: 16, left: 16 };
  }
}

export default function Pinsource(props: DevToolsProps = {}) {
  const { shouldRender, defaultCorner = "bottom-right", ...pickerOptions } = props;
  const enabled = shouldRender ? shouldRender() : process.env.NODE_ENV !== "production";
  if (!enabled) return null;
  return <Inner defaultCorner={defaultCorner} pickerOptions={pickerOptions} />;
}

function Inner({
  defaultCorner,
  pickerOptions,
}: {
  defaultCorner: NonNullable<DevToolsProps["defaultCorner"]>;
  pickerOptions: DevToolsOptions;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"full" | "compact" | null>(null);
  const [shotStatus, setShotStatus] = useState<
    | { state: "idle" }
    | { state: "capturing" }
    | { state: "done"; result: ScreenshotResult }
  >({ state: "idle" });
  const [pos, setPos] = useState<{ top?: number; left?: number; right?: number; bottom?: number }>(
    cornerToPos(defaultCorner),
  );
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const picker = useElementPicker(pickerOptions);
  const portalHost = usePortalHost();

  const resolvedSourceFile = picker.sourceFile === UNRESOLVED_SENTINEL ? "" : picker.sourceFile;
  const sourceFileState: "resolving" | "found" | "unresolved" =
    picker.sourceFile === UNRESOLVED_SENTINEL
      ? "unresolved"
      : picker.sourceFile
      ? "found"
      : "resolving";

  const picked: PickedElement = useMemo(
    () => ({
      elementPath: picker.elementPath,
      componentLabel: picker.componentLabel,
      componentChain: picker.componentChain,
      sourceFile: resolvedSourceFile,
      sourceCandidates: picker.sourceCandidates,
      pageRoute: picker.pageRoute,
      pageFile: picker.pageFile,
      tag: picker.tag,
      styles: picker.styles,
    }),
    [picker, resolvedSourceFile],
  );

  const hasSelection = !!picker.selectedElement;

  const handlePointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-drag-ignore]")) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: rect.left,
      origY: rect.top,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setPos({ left: Math.max(0, dragRef.current.origX + dx), top: Math.max(0, dragRef.current.origY + dy) });
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const handleCopy = useCallback(
    async (variant: "full" | "compact") => {
      if (!hasSelection) return;
      const text = variant === "full" ? formatForCopy(picked) : formatCompactCopy(picked);
      try {
        await navigator.clipboard.writeText(text);
        setCopied(variant);
        setTimeout(() => setCopied(null), 1500);
      } catch {
        setCopied(null);
      }
    },
    [hasSelection, picked],
  );

  const handleScreenshot = useCallback(
    async (forceDownload = false) => {
      if (!picker.selectedElement) return;
      setShotStatus({ state: "capturing" });
      const label = picker.componentLabel.replace(/[<>/\s]/g, "") || "element";
      const result = await captureElement(picker.selectedElement, { label, forceDownload });
      setShotStatus({ state: "done", result });
      setTimeout(() => setShotStatus({ state: "idle" }), 2200);
    },
    [picker.selectedElement, picker.componentLabel],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        picker.togglePicker();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picker]);

  // Collapse panel while picking so the user can see the page clearly.
  // Re-open it automatically when a selection lands.
  const wasPickingRef = useRef(false);
  useEffect(() => {
    if (picker.active) {
      wasPickingRef.current = true;
      setOpen(false);
    } else if (wasPickingRef.current && picker.selectedElement) {
      wasPickingRef.current = false;
      setOpen(true);
    } else if (!picker.active) {
      wasPickingRef.current = false;
    }
  }, [picker.active, picker.selectedElement]);

  // Portal host isn't ready until after first client effect (SSR guard).
  // Render nothing on the server / first paint — avoids hydration mismatch.
  if (!portalHost) return null;

  const tree = (
    <>
      <style>{`
        @keyframes pinsource-pop {
          from { opacity: 0; transform: translateY(8px) scale(0.96); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes pinsource-pulse {
          0%, 100% { box-shadow: 0 10px 30px rgba(34,197,94,0.45), 0 2px 6px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.25), 0 0 0 0 rgba(34,197,94,0.5); }
          50%      { box-shadow: 0 10px 30px rgba(34,197,94,0.45), 0 2px 6px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.25), 0 0 0 10px rgba(34,197,94,0); }
        }
        @keyframes pinsource-dot-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.55; transform: scale(1.35); }
        }
        [data-pinsource] [data-icon-btn]:hover {
          background: rgba(255,255,255,0.08) !important;
          color: #e5e7eb !important;
        }
        [data-pinsource] [data-primary-action]:hover {
          transform: translateY(-1px);
          box-shadow: 0 6px 18px rgba(229,57,53,0.5);
        }
        [data-pinsource] [data-secondary-action]:hover {
          background: rgba(255,255,255,0.08) !important;
        }
        [data-pinsource] [data-fab]:hover {
          transform: scale(1.05);
        }
        [data-pinsource] [data-fab]:active {
          transform: scale(0.96);
        }
      `}</style>
      <div data-pinsource style={{ ...styles.root, ...pos }}>
        {open && (
          <div style={styles.panel} data-drag-ignore>
            <div
              style={styles.panelHeader}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
            >
              <span style={{ color: "#6b7280" }}>
                <DragHandleIcon />
              </span>
              {(() => {
                const state: "picking" | "selected" | "idle" = picker.active
                  ? "picking"
                  : hasSelection
                  ? "selected"
                  : "idle";
                const dotColor =
                  state === "picking" ? "#22c55e" : state === "selected" ? "#3b82f6" : "#6b7280";
                const dotShadow =
                  state === "picking"
                    ? "0 0 8px rgba(34,197,94,0.8)"
                    : state === "selected"
                    ? "0 0 6px rgba(59,130,246,0.6)"
                    : "none";
                const label =
                  state === "picking"
                    ? "picking…"
                    : state === "selected"
                    ? picker.componentLabel.replace(/[<>/\s]/g, "") || "pinsource"
                    : "pinsource";
                const tooltip =
                  state === "picking"
                    ? "Picker active — click any element to inspect it"
                    : state === "selected"
                    ? `Selected: ${picker.componentLabel || "element"}`
                    : "Idle — click the target button to pick an element";
                return (
                  <span style={styles.panelTitle} title={tooltip}>
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: dotColor,
                        boxShadow: dotShadow,
                        animation:
                          state === "picking"
                            ? "pinsource-dot-pulse 1.4s ease-in-out infinite"
                            : "none",
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontFamily:
                          state === "selected"
                            ? "ui-monospace, SFMono-Regular, Menlo, monospace"
                            : "inherit",
                        fontSize: state === "selected" ? 11.5 : 12,
                      }}
                    >
                      {label}
                    </span>
                  </span>
                );
              })()}
              {hasSelection && (
                <button
                  data-drag-ignore
                  data-icon-btn
                  onClick={() => {
                    picker.clearSelection();
                    picker.togglePicker();
                  }}
                  style={styles.iconButton}
                  title="Pick another element (⌘⇧C)"
                >
                  <CrosshairIcon active={false} size={13} />
                </button>
              )}
              <button
                data-drag-ignore
                data-icon-btn
                onClick={() => setOpen(false)}
                style={styles.iconButton}
                title="Close"
              >
                <CloseIcon />
              </button>
            </div>

            <div style={styles.panelBody}>
              {!hasSelection && !picker.active && (
                <div style={styles.emptyState}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 48,
                      height: 48,
                      borderRadius: "50%",
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.06)",
                      color: "#9ca3af",
                      marginBottom: 14,
                    }}
                  >
                    <SparkIcon size={22} />
                  </div>
                  <div style={{ marginBottom: 16, maxWidth: 240 }}>
                    Pick any element on the page to inspect its component, source file, and styles.
                  </div>
                  <button
                    data-primary-action
                    onClick={picker.togglePicker}
                    style={{ ...styles.primaryAction, width: "100%", marginBottom: 10 }}
                  >
                    <CrosshairIcon active={false} size={14} />
                    Start picking
                  </button>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 4,
                      fontSize: 10.5,
                      color: "#6b7280",
                    }}
                  >
                    <span>or press</span>
                    <span style={styles.kbd}>⌘</span>
                    <span style={styles.kbd}>Shift</span>
                    <span style={styles.kbd}>C</span>
                  </div>
                </div>
              )}

              {picker.active && !hasSelection && (
                <div style={styles.emptyState}>
                  <div style={{ color: "#22c55e", fontWeight: 600, marginBottom: 6 }}>Picking…</div>
                  <div style={{ fontSize: 11 }}>
                    Hover to highlight, click to select. Press <span style={styles.kbd}>Esc</span> to cancel.
                  </div>
                </div>
              )}

              {hasSelection && (
                <>
                  <div style={styles.card}>
                    <div style={styles.label}>Component</div>
                    <div style={{ ...styles.valueMono, fontWeight: 600, color: "#f3f4f6" }}>
                      {picker.componentLabel || "(unknown)"}
                    </div>
                  </div>

                  <div style={styles.card}>
                    <div style={styles.label}>Source file</div>
                    <div style={styles.valueMono}>
                      {sourceFileState === "found" && resolvedSourceFile}
                      {sourceFileState === "resolving" && (
                        <span style={{ color: "#6b7280", fontStyle: "italic" }}>resolving…</span>
                      )}
                      {sourceFileState === "unresolved" && (
                        isBackendConnected() ? (
                          <span style={{ color: "#f59e0b" }}>
                            no match{" "}
                            <span style={{ color: "#6b7280" }}>
                              — resolver couldn&apos;t locate{" "}
                              <code style={{ color: "#9ca3af" }}>
                                {picker.componentChain[0] || picker.componentLabel.replace(/[<>/\s]/g, "") || "component"}
                              </code>
                              {" "}in your source dirs
                            </span>
                          </span>
                        ) : (
                          <span style={{ color: "#f59e0b" }}>
                            resolver unreachable{" "}
                            <span style={{ color: "#6b7280" }}>
                              — run{" "}
                              <code style={{ color: "#9ca3af" }}>npx pinsource init</code>
                              {" "}then{" "}
                              <code style={{ color: "#9ca3af" }}>npm run dev</code>
                            </span>
                          </span>
                        )
                      )}
                    </div>
                  </div>

                  <div style={styles.card}>
                    <div style={styles.label}>Page</div>
                    <div style={styles.valueMono}>
                      {picker.pageFile || picker.pageRoute || "/"}
                    </div>
                  </div>

                  {picker.componentChain.length > 1 && (
                    <CollapsibleCard
                      label="Ancestor chain"
                      count={picker.componentChain.length}
                    >
                      <div style={styles.chainRow}>
                        {picker.componentChain.join(" › ")}
                      </div>
                    </CollapsibleCard>
                  )}
                </>
              )}
            </div>

            {hasSelection && (
              <div style={styles.panelFooter}>
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <button
                    data-secondary-action
                    onClick={() => handleCopy("compact")}
                    style={{
                      ...styles.secondaryAction,
                      ...(copied === "compact" ? styles.secondaryActionSuccess : {}),
                      flex: 1,
                      padding: "7px 8px",
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                    title="Copy @file references"
                  >
                    <CopyIcon copied={copied === "compact"} size={11} />
                    {copied === "compact" ? "Copied" : "Copy source"}
                  </button>
                  <button
                    data-secondary-action
                    onClick={() => handleCopy("full")}
                    style={{
                      ...styles.secondaryAction,
                      ...(copied === "full" ? styles.secondaryActionSuccess : {}),
                      padding: "7px 8px",
                      fontSize: 11,
                    }}
                    title="Copy full prompt block (component, file refs, chain, styles)"
                  >
                    {copied === "full" ? "Copied" : "Full prompt"}
                  </button>
                  <button
                    data-secondary-action
                    onClick={(e) => handleScreenshot(e.shiftKey)}
                    disabled={shotStatus.state === "capturing"}
                    style={{
                      ...styles.secondaryAction,
                      ...(shotStatus.state === "done" && shotStatus.result.kind !== "error"
                        ? styles.secondaryActionSuccess
                        : {}),
                      padding: "7px 8px",
                      width: 34,
                      justifyContent: "center",
                      opacity: shotStatus.state === "capturing" ? 0.6 : 1,
                    }}
                    title={
                      shotStatus.state === "done" && shotStatus.result.kind === "copied"
                        ? "Screenshot copied to clipboard"
                        : shotStatus.state === "done" && shotStatus.result.kind === "downloaded"
                        ? `Saved ${shotStatus.result.filename}`
                        : shotStatus.state === "done" && shotStatus.result.kind === "error"
                        ? `Failed: ${shotStatus.result.reason}`
                        : "Screenshot element (Shift-click to download)"
                    }
                  >
                    {shotStatus.state === "capturing" ? (
                      <span style={{ fontSize: 10 }}>…</span>
                    ) : shotStatus.state === "done" && shotStatus.result.kind !== "error" ? (
                      <CopyIcon copied size={11} />
                    ) : (
                      <CameraIcon size={12} />
                    )}
                  </button>
                </div>
                {shotStatus.state === "done" && (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 10.5,
                      color:
                        shotStatus.result.kind === "error"
                          ? "#f87171"
                          : "#86efac",
                      textAlign: "center",
                    }}
                  >
                    {shotStatus.result.kind === "copied" && "📋 Screenshot copied to clipboard"}
                    {shotStatus.result.kind === "downloaded" && `💾 Downloaded ${shotStatus.result.filename}`}
                    {shotStatus.result.kind === "error" && `Capture failed: ${shotStatus.result.reason}`}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <button
          data-fab
          aria-label={
            picker.active
              ? "Cancel picking"
              : open
              ? "Pick another element"
              : hasSelection
              ? "View picked element"
              : "Start picking"
          }
          onClick={() => {
            if (picker.active) {
              picker.togglePicker();
              return;
            }
            if (open && hasSelection) {
              picker.clearSelection();
              picker.togglePicker();
              return;
            }
            setOpen((v) => !v);
          }}
          style={{
            ...styles.fab,
            ...(picker.active
              ? { ...styles.fabActive, animation: "pinsource-pulse 1.6s ease-in-out infinite" }
              : {}),
          }}
          title={
            picker.active
              ? "Cancel picking (Esc)"
              : open
              ? "Pick another element (⌘⇧C)"
              : hasSelection
              ? "View picked element"
              : "Start picking (⌘⇧C)"
          }
        >
          {picker.active || open ? <CrosshairIcon active={picker.active} size={22} /> : <SparkIcon size={22} />}
          {hasSelection && !open && !picker.active && <span style={styles.fabBadge}>1</span>}
        </button>
      </div>
    </>
  );

  return createPortal(tree, portalHost);
}
