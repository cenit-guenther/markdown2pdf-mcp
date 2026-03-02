# Copilot Instructions

## Build, Test, and Lint

```bash
npm run build        # tsc compile + chmod build/index.js + copy static assets
npm run copy-assets  # copies src/css/pdf.css, src/puppeteer/render.js, src/runnings.js → build/
npm test             # run all Jest tests (ESM mode)
```

Run a single test by name:
```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js -t "increments duplicate filenames"
```

Run a single test file:
```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js test/index.test.ts
```

## Docker

```bash
# Build image
docker build -t markdown2pdf-mcp .

# Run as remote MCP server (HTTP + SSE)
docker run -p 3000:3000 \
  -e MCP_BASE_URL=http://your-host:3000 \
  markdown2pdf-mcp
```

## Transport Modes

The server supports two transport modes selected by `MCP_TRANSPORT`:

**stdio** (default — for local MCP clients):
```bash
node build/index.js
# or: MCP_TRANSPORT=stdio node build/index.js
```

**http** (for remote/Docker deployments):
```bash
MCP_TRANSPORT=http MCP_BASE_URL=http://localhost:3000 node build/index.js
```

HTTP mode exposes:
- `POST /mcp` — StreamableHTTP transport (MCP protocol 2025-11-25)
- `GET /sse` + `POST /messages` — Legacy SSE transport (MCP protocol 2024-11-05)
- `GET /pdf/:id` — PDF download endpoint

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_PORT` | `3000` | HTTP server listen port |
| `MCP_BASE_URL` | `http://localhost:3000` | Public base URL for PDF download links |
| `PDF_TTL_MS` | `600000` | Milliseconds until ephemeral PDF expires (10 min) |
| `M2P_OUTPUT_DIR` | `$HOME` | Output directory (stdio mode only) |
| `M2P_VERBOSE` | — | Set to `true` for verbose Puppeteer debug logging |

## Architecture

This is an **MCP server** exposing one tool (`create_pdf_from_markdown`). The data flow is:

```
MCP client → src/index.ts (MarkdownPdfServer)
               ↓ renders Markdown → HTML (Remarkable + highlight.js)
               ↓ writes temp .html file (tmp)
             src/puppeteer/render.js
               ↓ launches headless Chrome (Puppeteer, pinned to Chrome 131)
               ↓ loads HTML, waits for Mermaid diagrams to render
               ↓ injects src/css/pdf.css stylesheet
               ↓ calls page.pdf() with header/footer from src/runnings.js
             → PDF file on disk (stdio mode)
               OR ephemeral buffer in src/pdfStore.ts → download URL (http mode)
```

**Transport selection** (`MCP_TRANSPORT` env var):
- `stdio` (default): `run()` → `runStdio()` — connects `StdioServerTransport`, PDF saved to disk
- `http`: `run()` → `runHttp()` — starts Express with StreamableHTTP + SSE endpoints, PDF stored ephemerally and returned as a download URL

**Per-session server instances in HTTP mode**: `runHttp()` calls `createMcpServer()` for each new MCP session (each `SSEServerTransport` or `StreamableHTTPServerTransport`). The `MarkdownPdfServer.server` field is only used in stdio mode.

**Static JS files** (`src/puppeteer/render.js`, `src/runnings.js`) are not compiled by TypeScript — they are copied verbatim to `build/` by `npm run copy-assets`. Edit them directly; changes require `npm run copy-assets` (not a full `npm run build`) to take effect.

**`src/runnings.js`** produces the Puppeteer header/footer HTML templates (watermark + page numbers). It exports a default function that returns `{ header, footer }` strings.

**`src/pdfStore.ts`** is an in-memory TTL store: `storePdf(buffer, filename) → id`, `retrievePdf(id) → {buffer, filename} | undefined`. Each entry is auto-deleted via `setTimeout` after `PDF_TTL_MS` milliseconds.

## Key Conventions

### ESM + CJS interop
The package uses `"type": "module"` with TypeScript `Node16` module resolution. CommonJS packages (`highlight.js`, `remarkable`, `tmp`, `package.json`) are loaded via `createRequire(import.meta.url)` in `src/index.ts`. Imports of local `.js` files must include the `.js` extension even for `.ts` source files.

### Output directory resolution (stdio mode, priority order)
1. `M2P_OUTPUT_DIR` environment variable
2. Directory component of `outputFilename` (if it contains a path)
3. `os.homedir()`

In HTTP mode, the PDF is written to `os.tmpdir()`, buffered, then deleted from disk.

### Filename collision handling
`getIncrementalPath()` auto-increments filenames: `output.pdf` → `output-1.pdf` → `output-2.pdf` etc.

### Verbose logging
Set `M2P_VERBOSE=true` to enable `[markdown2pdf]` debug output to stderr in `render.js`.

### Mermaid diagrams
Mermaid is rendered client-side via CDN (`mermaid@10`) inside the headless Chrome page. Syntax errors are surfaced in the PDF via a red `#mermaid-error` div rather than throwing.

### Dynamic timeouts
Load and render timeouts are calculated from content size/line count in `index.ts` and passed through to `render.js`. Base values: 60s load, 7s render; max: 5 min load, 30s render.

### Tests mock the renderer
`test/index.test.ts` mocks both `@modelcontextprotocol/sdk` and `src/puppeteer/render.js` — no real Chrome or PDF generation occurs in unit tests. The mock writes a stub `'PDF'` file to satisfy the file-existence check.
