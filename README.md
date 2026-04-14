# pinsource

**Click any element on your running app → get its source file.** A floating devtool for React, Next.js, Vite, and any modern web stack.

Built for the moment you're staring at your app and thinking *"where is this code?"* Pick the element, copy a ready-to-paste reference, keep moving.

```
<ProductCard />
→ components/ProductCard.tsx:31
```

## Quick start

### Next.js (App Router)

```bash
npm install --save-dev pinsource
```

Add two small files. **That's the entire setup.**

```ts
// app/api/__pinsource/route.ts
export { POST } from "pinsource/next-route";
```

```tsx
// app/layout.tsx
import PinsourceLoader from "pinsource/loader";

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <PinsourceLoader />
      </body>
    </html>
  );
}
```

Run `next dev`, open your app, look for the floating button in the bottom-right corner.

### Vite

```bash
npm install --save-dev pinsource
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import pinsource from "pinsource/vite-plugin";

export default defineConfig({
  plugins: [pinsource()],
});
```

```tsx
// main.tsx (or wherever your root renders)
import PinsourceLoader from "pinsource/loader";

<>
  <App />
  <PinsourceLoader />
</>
```

### Next.js (Pages Router)

```ts
// pages/api/__pinsource.ts
export { default } from "pinsource/next-route";
```

Then mount `<PinsourceLoader />` in `_app.tsx`.

### CRA, Webpack, Remix, anything else

Mount the loader in your root component, then run the standalone resolver:

```bash
npx pinsource-server
```

Or bake it into your dev script:

```json
{
  "scripts": {
    "dev": "trap 'kill 0' INT TERM; your-dev-command & pinsource-server & wait"
  }
}
```

---

## Using it

1. Click the floating button (or press **⌘⇧C** / **Ctrl⇧C**)
2. Hover to highlight, click to select
3. Hit **Copy source** — paste it anywhere

### Output shapes

**`Copy source`** — compact `@file:line` refs, perfect for chat and PRs:

```
ChatInput:
  @app/chat/components/ChatInput.tsx:14
  @app/chat/page.tsx
```

**`Full prompt`** — structured block with context, for AI assistants:

```
**Component:** `ChatInput`
**Route:** `/chat`
**DOM tag:** `<div>`

**File references (open these first):**
- @app/chat/components/ChatInput.tsx:14  ← component definition
- @app/chat/page.tsx  ← page where it was picked

**Component chain (nearest → outermost):**
**ChatInput** → ChatComposer → ChatSession

**DOM path:**
`div#root > main > div.flex > div.composer`

**Computed styles:**
- size: 720 × 56
- display: flex
- direction: row
- gap: 8px
- padding: 12px
- background: rgb(17, 17, 20)
```

**Screenshot** — the camera button captures the picked element as a PNG and copies it to your clipboard. Paste straight into Claude, Slack, or a PR.

### Keyboard shortcuts

| Shortcut                     | Action                    |
| ---------------------------- | ------------------------- |
| `⌘ Shift C` / `Ctrl Shift C` | Toggle the element picker |
| `Esc`                        | Cancel picking            |

---

## Configuration

```tsx
<PinsourceLoader
  defaultCorner="bottom-right"
  shouldRender={() => true}
  skipComponents={["FeatureFlagGate"]}
/>
```

| Option           | Type                                                           | Default                                 | Description                                                                    |
| ---------------- | -------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| `defaultCorner`  | `"top-left" \| "top-right" \| "bottom-left" \| "bottom-right"` | `"top-left"`                            | Initial panel position. Panel is draggable after mount.                        |
| `shouldRender`   | `() => boolean`                                                | `process.env.NODE_ENV !== "production"` | Gate visibility. Use this to expose the panel in staging or behind a flag.     |
| `skipComponents` | `string[]`                                                     | `[]`                                    | Extra component names to skip when walking the fiber ancestor chain.           |
| `serverUrl`      | `string`                                                       | auto-detected                           | Override the resolver URL. Usually unneeded — the panel finds the endpoint automatically. |

### Resolver environment variables

Only relevant for the standalone server — the Next.js route and Vite plugin inherit the project's `process.cwd()`.

| Variable         | Default                                     | Description                                       |
| ---------------- | ------------------------------------------- | ------------------------------------------------- |
| `PINSOURCE_PORT` | `9101`                                      | Port the standalone HTTP server binds to.         |
| `PINSOURCE_CWD`  | `process.cwd()`                             | Directory the server greps within.                |
| `PINSOURCE_DIRS` | `"app components handlers lib src pages"` | Space-separated list of subdirectories to search. |

---

## How it works

1. **Fiber walk.** When you click an element, pinsource reads the React fiber attached to the DOM node and walks upward, collecting the `displayName` or `name` of each real component. Framework wrappers (router internals, error boundaries, providers) are skipped automatically.
2. **Source resolution.** If the bundler injected `_debugSource` (Next.js dev, Vite dev, CRA dev all do this by default), the exact `file:line` is read straight from the fiber — no network call. Otherwise, the panel hits a local `/resolve` endpoint that runs a scored `grep` over your source directories and picks the highest-confidence definition, skipping re-exports and imports.
3. **Rendering.** The panel shows the resolved file, ancestor chain, and key computed styles, with one-click copy and screenshot actions.

### Endpoint discovery

On the first pick, the panel probes these endpoints in parallel and caches the winner:

1. `/__pinsource/resolve` (Vite plugin)
2. `/api/__pinsource` (Next.js route)
3. `http://localhost:9101/resolve` (standalone server)

You never have to set a URL unless you want to override it.

---

## Security

- **Dev-only**: the loader renders nothing when `NODE_ENV === "production"`, and the Next route returns 403 in production.
- **Localhost-only**: the standalone server binds to `127.0.0.1`.
- **No network calls**: nothing about your code ever leaves the machine — all resolution is local `grep` + `find`.

## Exports

```ts
import Pinsource from "pinsource";                            // main component
import PinsourceLoader from "pinsource/loader";               // lazy, dev-only wrapper
import { useElementPicker, resolveComponentFile, resolvePageFile }
  from "pinsource";                                           // primitives
import type { DevToolsOptions, PickedElement, PickerState }
  from "pinsource";
```

## Requirements

- React 18+
- Node 18+

## License

MIT
