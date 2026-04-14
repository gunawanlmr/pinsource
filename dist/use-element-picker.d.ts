import type { DevToolsOptions } from "./types";
interface DebugSource {
    fileName?: string;
    lineNumber?: number;
    columnNumber?: number;
}
export interface FiberComponent {
    name: string;
    /** File + line from Babel jsx-dev-runtime / @babel/plugin-transform-react-jsx-source, if available. */
    debugSource: DebugSource | null;
}
/** Marker written to `sourceFile` when resolution completes but finds nothing. */
export declare const UNRESOLVED_SENTINEL = "__pinsource_unresolved__";
export declare function useElementPicker(options?: DevToolsOptions): {
    togglePicker: () => void;
    clearSelection: () => void;
    active: boolean;
    hoveredSelector: string;
    selectedElement: HTMLElement | null;
    elementPath: string;
    componentLabel: string;
    componentChain: string[];
    sourceFile: string;
    pageRoute: string;
    pageFile: string;
    tag: string;
    styles: Record<string, string>;
};
export {};
//# sourceMappingURL=use-element-picker.d.ts.map