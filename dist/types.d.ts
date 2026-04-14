export interface PickedElement {
    /** CSS-selector-like path from <body> to the element. */
    elementPath: string;
    /** Human label of nearest meaningful React component, e.g. "<Button />". */
    componentLabel: string;
    /** Ancestor component chain (nearest → outermost). */
    componentChain: string[];
    /** Resolved source file + line, e.g. "components/ui/button.tsx:42". */
    sourceFile: string;
    /** Current window.location.pathname. */
    pageRoute: string;
    /** Resolved page file, e.g. "app/(root)/search/page.tsx". */
    pageFile: string;
    /** Tag name + key computed styles, lightweight summary. */
    tag: string;
    styles: Record<string, string>;
}
export interface PickerState extends PickedElement {
    active: boolean;
    hoveredSelector: string;
    selectedElement: HTMLElement | null;
}
export interface DevToolsOptions {
    /** HTTP endpoint that resolves component names & routes to file paths. Default: http://localhost:9101 */
    serverUrl?: string;
    /** Extra component names to skip when walking fiber ancestors. */
    skipComponents?: string[];
    /** Only render when this returns true. Default: process.env.NODE_ENV === "development". */
    shouldRender?: () => boolean;
}
//# sourceMappingURL=types.d.ts.map