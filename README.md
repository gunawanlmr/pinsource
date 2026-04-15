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

**1.** Create the API route. The extra re-exports (`runtime`, `dynamic`) pin the handler to Node.js and disable caching — both required for the resolver to work:

```ts
// app/api/__pinsource/route.ts
export { POST, GET, runtime, dynamic } from "pinsource/next-route";
```

**2.** Mount the devtools loader in your root layout. `PinsourceLoader` renders nothing in production builds, so it's safe to leave in the tree:

```tsx
// app/layout.tsx
import PinsourceLoader from "pinsource/loader";

export default function RootLayout({ children }: { children: React.ReactNode }) {
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

**3.** Run `next dev` and open your app. Look for the floating button in the bottom-right corner.

**Verify the API route is mounted.** Open `http://localhost:3000/api/__pinsource` in a browser — you should see:

```json
{ "ok": true, "service": "pinsource", "runtime": "nodejs" }
```

If you get a 404, the route file is in the wrong place. If you get a 500, check your server logs — the most common cause is the route accidentally running on the Edge runtime (make sure you re-exported `runtime` as shown above).

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

export const config = { api: { bodyParser: true } };
```

Then mount `<PinsourceLoader />` in `_app.tsx`:

```tsx
// pages/_app.tsx
import PinsourceLoader from "pinsource/loader";

export default function App({ Component, pageProps }) {
  return (
    <>
      <Component {...pageProps} />
      <PinsourceLoader />
    </>
  );
}
```

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

## Troubleshooting

### Next.js: "source file: not found"

The panel picks elements but the **Source file** card shows `not found`.

1. **Verify the route is mounted.** Open `http://localhost:3000/api/__pinsource` — you should get a `{ ok: true }` JSON response. If 404, the file is in the wrong place (should be `app/api/__pinsource/route.ts` for App Router, `pages/api/__pinsource.ts` for Pages Router).
2. **Verify the runtime.** Open your browser DevTools → Network tab → pick an element. Find the `__pinsource` request. If the response is 500 and the server log says `"child_process" is not supported in the Edge Runtime`, your `route.ts` is missing `export { runtime } from "pinsource/next-route"` — add it.
3. **Check `NODE_ENV`.** The route returns 403 in production. `next dev` runs in development by default; make sure you haven't set `NODE_ENV=production` in `.env.local`.
4. **Fall back to the standalone server.** Run `npx pinsource-server` in a second terminal — it binds to `localhost:9101` and works regardless of framework. The client auto-detects it.

### Vite: devtools show but "not found"

Make sure the plugin is registered in `vite.config.ts` and that you're running `vite dev` (not preview or build). The plugin is `apply: "serve"` only.

### TypeScript error: "Cannot find module 'pinsource/next-route'"

Update to `pinsource@0.3+` — earlier versions shipped the subpath export without type declarations. If already on latest, make sure your `tsconfig.json` has `"moduleResolution": "bundler"` or `"node16"` so subpath exports are honored.

### Checking the resolver directly

```bash
# Health check
curl http://localhost:3000/api/__pinsource

# Try to resolve a component
curl -X POST http://localhost:3000/api/__pinsource \
  -H 'Content-Type: application/json' \
  -d '{"kind":"component","name":"ProductCard"}'

# Try to resolve a route
curl -X POST http://localhost:3000/api/__pinsource \
  -H 'Content-Type: application/json' \
  -d '{"kind":"page","route":"/dashboard"}'
```

Each should return `{"file":"...","line":N}` or an empty `{}` if not found.

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
