# pinsource

Pin any UI element in your running web app to its source file. A floating in-browser devtool for React, Vite, Next.js, and any modern web stack.

Pick an element → pinsource resolves the component, source file path, route, ancestor chain, and computed styles, then copies a structured reference block to your clipboard.

## Why

When you're looking at a running app and want to change something, the slowest step is usually *finding the file*. pinsource collapses that step: click the element, paste the reference, done.

## Features

- **Floating panel.** Fixed position, draggable, stays out of the way.
- **Element picker.** Hover to highlight, click to select. Walks the React fiber tree to find the nearest meaningful component.
- **Source file resolution.** A local HTTP server in your project directory resolves component names to `path/to/file.tsx:lineNumber`.
- **Route resolution.** Maps `window.location.pathname` to the page/layout file (Next.js App Router, Pages Router, and common conventions).
- **Two copy modes.**
  - *Copy source* — compact `@file:line` references, ideal for quick mentions in chat or PR comments.
  - *Full prompt* — structured block with file references, component chain, DOM path, and key computed styles.
- **Development-only by default.** Renders nothing when `process.env.NODE_ENV === "production"`.

## Installation

```bash
npm install --save-dev pinsource
# or
yarn add --dev pinsource
```

Peer dependencies: `react >= 18`, `react-dom >= 18`.

## Usage

### 1. Mount the loader

```tsx
// app/layout.tsx (Next.js App Router)
import PinsourceLoader from "pinsource/loader";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <PinsourceLoader />
      </body>
    </html>
  );
}
```

For Vite / CRA / anything else, mount it in your root component. The loader lazy-imports the bundle and renders nothing in production builds.

### 2. Run the resolver server

The panel calls a local HTTP endpoint to resolve component names and routes to file paths. The endpoint runs `grep` and `find` within your project directory — nothing is sent to any external service.

```bash
npx pinsource-server
```

Or alongside your dev server (example with a POSIX shell, no extra deps):

```json
{
  "scripts": {
    "dev": "trap 'kill 0' INT TERM; next dev & pinsource-server & wait"
  }
}
```

## Keyboard shortcuts

| Shortcut                           | Action                     |
| ---------------------------------- | -------------------------- |
| `⌘ Shift C` / `Ctrl Shift C`       | Toggle the element picker  |
| `Esc`                              | Cancel picking             |

## Output format

### `Copy source`

```
ChatInput:
  @app/chat/components/ChatInput.tsx:14
  @app/chat/page.tsx
```

### `Full prompt`

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

## Configuration

```tsx
<PinsourceLoader
  serverUrl="http://localhost:9101"
  defaultCorner="bottom-right"
  shouldRender={() => true}
  skipComponents={["MyProvider", "FeatureFlagGate"]}
/>
```

| Option           | Type                                                           | Default                                 | Description                                                              |
| ---------------- | -------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| `serverUrl`      | `string`                                                       | `http://localhost:9101`                 | Base URL of the resolver HTTP server.                                    |
| `defaultCorner`  | `"top-left" \| "top-right" \| "bottom-left" \| "bottom-right"` | `"top-left"`                            | Initial panel position. Panel is draggable after mount.                  |
| `shouldRender`   | `() => boolean`                                                | `process.env.NODE_ENV !== "production"` | Gate visibility. Use this to expose the panel in staging or behind a flag. |
| `skipComponents` | `string[]`                                                     | `[]`                                    | Extra component names to skip when walking the fiber ancestor chain.     |

### Resolver server environment

| Variable              | Default                                   | Description                                                 |
| --------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| `PINSOURCE_PORT`      | `9101`                                    | Port the HTTP server binds to.                              |
| `PINSOURCE_CWD`       | `process.cwd()`                           | Directory the server greps within.                          |
| `PINSOURCE_DIRS`      | `"app components handlers lib src"`       | Space-separated list of subdirectories to search.           |

## How it works

1. **Fiber walk.** When you click an element while the picker is active, pinsource reads the React fiber attached to the DOM node (via the `__reactFiber$*` property) and walks upward, collecting the `displayName` or `name` of each function/class component. Known framework wrappers (router internals, error/suspense boundaries, common providers) are skipped.
2. **Name resolution.** The resulting list of component names, plus `window.location.pathname`, is sent to the resolver server via `POST /resolve`. The server runs a set of `grep` patterns over your configured source directories to locate the definition.
3. **Rendering.** The panel displays the resolved file path, component chain, and a summary of computed styles, and exposes the two copy actions.

No source code is transmitted off the machine. The resolver only accepts connections on `localhost` by default.

## Exports

```ts
import Pinsource from "pinsource";                            // main component
import PinsourceLoader from "pinsource/loader";               // lazy wrapper
import { useElementPicker, resolveComponentFile, resolvePageFile }
  from "pinsource";                                           // primitives
import type { DevToolsOptions, PickedElement, PickerState }
  from "pinsource";
```

## Requirements

- React 18 or later
- Node.js 18 or later (for the resolver server)

## License

MIT
