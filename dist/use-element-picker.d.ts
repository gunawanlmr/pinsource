import type { DevToolsOptions } from "./types";
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
//# sourceMappingURL=use-element-picker.d.ts.map