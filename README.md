# pinsource

**Click any element on your running app → get its source file.** A floating devtool for React, Next.js, Vite, and any modern web stack.

```
<ProductCard />
→ components/ProductCard.tsx:31
```

## Quick start

```bash
npm install --save-dev pinsource
npx pinsource init
```

`init` patches your `dev` script to wrap the resolver. Then mount the loader in your root layout / entry file:

```tsx
import PinsourceLoader from "pinsource/loader";

<>
  <App />
  <PinsourceLoader />
</>
```

Run `npm run dev` and look for the floating button in the bottom-right corner.

That's it. Same setup for Next, Vite, CRA, Remix, anything else.

## Using it

1. Click the floating button (or press **⌘⇧C** / **Ctrl⇧C**)
2. Hover to highlight, click to select
3. Hit **Copy source** — paste it anywhere

### Output

**`Copy source`** — LLM-friendly fenced block. Drop it into Claude, Cursor, ChatGPT, or a PR comment:

````
```pinsource
component: ChatInput
tag: textarea
route: /chat
source: app/chat/components/ChatInput.tsx:14
page: app/chat/page.tsx
chain: ChatInput > ChatComposer > ChatSession
```
````

**`Full prompt`** — verbose block with computed styles and ancestor chain, for AI-assisted edits.

**Screenshot** — captures the picked element as a PNG and copies it to your clipboard.

### Keyboard shortcuts

| Shortcut                     | Action                    |
| ---------------------------- | ------------------------- |
| `⌘ Shift C` / `Ctrl Shift C` | Toggle the element picker |
| `Esc`                        | Cancel picking            |

## Configuration

```tsx
<PinsourceLoader
  defaultCorner="bottom-right"
  shouldRender={() => true}
  skipComponents={["FeatureFlagGate"]}
/>
```

| Option           | Default                                 | Description                                                   |
| ---------------- | --------------------------------------- | ------------------------------------------------------------- |
| `defaultCorner`  | `"bottom-right"`                        | Initial panel position. Draggable after mount.                |
| `shouldRender`   | `process.env.NODE_ENV !== "production"` | Gate visibility (e.g. expose in staging).                     |
| `skipComponents` | `[]`                                    | Component names to skip when walking the fiber chain.         |
| `serverUrl`      | auto-detected                           | Override the resolver URL. Usually unneeded.                  |

### Resolver environment variables

| Variable         | Default                                     | Description                              |
| ---------------- | ------------------------------------------- | ---------------------------------------- |
| `PINSOURCE_PORT` | `9101`                                      | Resolver port.                           |
| `PINSOURCE_CWD`  | `process.cwd()`                             | Directory the resolver greps within.     |
| `PINSOURCE_DIRS` | `"app components handlers lib src pages"`   | Subdirectories to search.                |

## Alternative setups

If you'd rather not run the resolver as a sidecar process, you can mount it directly into your dev server.

### Next.js (App Router)

```ts
// app/api/__pinsource/route.ts
export { POST, GET, runtime, dynamic } from "pinsource/next-route";
```

### Next.js (Pages Router)

```ts
// pages/api/__pinsource.ts
export { default } from "pinsource/next-route";
export const config = { api: { bodyParser: true } };
```

### Vite

```ts
// vite.config.ts
import { defineConfig } from "vite";
import pinsource from "pinsource/vite-plugin";

export default defineConfig({ plugins: [pinsource()] });
```

The client auto-detects whichever backend is reachable — you don't need to configure anything else.

## How it works

1. **Fiber walk.** Reads the React fiber attached to the clicked DOM node and walks upward, collecting `displayName` / `name` of each real component. Framework wrappers are skipped.
2. **Source resolution.** Reads `_debugSource` from the fiber when bundlers inject it. Otherwise hits a local `/resolve` endpoint that runs a scored `grep` over your source dirs and picks the highest-confidence definition.
3. **Rendering.** Shows file, ancestor chain, and computed styles, with one-click copy and screenshot.

## Troubleshooting

**Panel says "resolver unreachable".** Run `npx pinsource init` and restart `npm run dev`. Or run `npx pinsource` in a second terminal.

**Picks an element but source shows "no match".** The component name couldn't be located in your source dirs. Check `PINSOURCE_DIRS` — by default it searches `app components handlers lib src pages`.

**Hitting the resolver directly:**

```bash
curl -X POST http://localhost:9101/resolve \
  -H 'Content-Type: application/json' \
  -d '{"kind":"component","name":"ProductCard"}'
```

## Security

- **Dev-only**: the loader renders nothing when `NODE_ENV === "production"`; the Next route returns 403.
- **Localhost-only**: the standalone server binds to `127.0.0.1`.
- **No network calls**: nothing leaves the machine — all resolution is local `grep` + `find`.

## Exports

```ts
import Pinsource from "pinsource";
import PinsourceLoader from "pinsource/loader";
import { useElementPicker, resolveComponentFile, resolvePageFile } from "pinsource";
import type { DevToolsOptions, PickedElement, PickerState } from "pinsource";
```

## Requirements

React 18+, Node 18+

## License

MIT
