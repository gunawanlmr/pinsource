"use client";

import { useEffect, useState, type ComponentType } from "react";

import type { DevToolsOptions } from "./types";

interface LoaderProps extends DevToolsOptions {
  defaultCorner?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
}

/**
 * Client-side lazy loader. Only imports the main component when rendered.
 * Use this as the root entry point in your app so the devtools code stays
 * out of the production bundle when `shouldRender` returns false.
 */
export default function PinsourceLoader(props: LoaderProps = {}) {
  const [Component, setComponent] = useState<ComponentType<LoaderProps> | null>(null);

  useEffect(() => {
    const enabled = props.shouldRender
      ? props.shouldRender()
      : process.env.NODE_ENV !== "production";
    if (!enabled) return;
    import("./Pinsource").then((mod) => {
      setComponent(() => mod.default as ComponentType<LoaderProps>);
    });
  }, [props]);

  if (!Component) return null;
  return <Component {...props} />;
}
