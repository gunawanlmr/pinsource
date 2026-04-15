export interface SourceCandidate {
  /** Component name at this level, or "(clicked)" for the host JSX site. */
  name: string;
  /** `path:line` relative to project root. */
  file: string;
  /** Higher = more likely to be the useful "composing" component. */
  score: number;
}

export interface PickedElement {
  /** CSS-selector-like path from <body> to the element. */
  elementPath: string;
  /** Human label of nearest meaningful React component, e.g. "<Button />". */
  componentLabel: string;
  /** Ancestor component chain (nearest → outermost). */
  componentChain: string[];
  /** Resolved source file + line, e.g. "components/ui/button.tsx:42". Best pick out of the candidates. */
  sourceFile: string;
  /**
   * All resolved sources along the ancestor chain, sorted from highest-level
   * (page, section) to lowest (atomic primitive). Lets consumers show context
   * like "FeatureCard → Card → primitives/Card.tsx" when the primary pick
   * is too atomic to be useful.
   */
  sourceCandidates: SourceCandidate[];
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
