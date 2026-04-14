import type { DevToolsOptions } from "./types";
interface LoaderProps extends DevToolsOptions {
    defaultCorner?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
}
/**
 * Client-side lazy loader. Only imports the main component when rendered.
 * Use this as the root entry point in your app so the devtools code stays
 * out of the production bundle when `shouldRender` returns false.
 */
export default function PinsourceLoader(props?: LoaderProps): import("react/jsx-runtime").JSX.Element | null;
export {};
//# sourceMappingURL=loader.d.ts.map