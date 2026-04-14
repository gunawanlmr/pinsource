"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import { useEffect, useState } from "react";
/**
 * Client-side lazy loader. Only imports the main component when rendered.
 * Use this as the root entry point in your app so the devtools code stays
 * out of the production bundle when `shouldRender` returns false.
 */
export default function PinsourceLoader(props = {}) {
    const [Component, setComponent] = useState(null);
    useEffect(() => {
        const enabled = props.shouldRender
            ? props.shouldRender()
            : process.env.NODE_ENV !== "production";
        if (!enabled)
            return;
        import("./Pinsource").then((mod) => {
            setComponent(() => mod.default);
        });
    }, [props]);
    if (!Component)
        return null;
    return _jsx(Component, { ...props });
}
//# sourceMappingURL=loader.js.map