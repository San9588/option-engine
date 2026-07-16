#!/usr/bin/env node
/**
 * ============================================================================
 * STANDALONE EXPORT SCRIPT (no npm/build step needed to RUN the output)
 * ============================================================================
 * Kya karta hai:
 *   - src/app/option-chain/page.tsx ko padhta hai
 *   - Next.js/npm-specific cheezein (imports, "use client", process.env)
 *     hata/replace karta hai
 *   - esbuild se TSX ko export-time par optimized JavaScript mein compile karta hai
 *   - Ek single standalone-export/index.html banata hai jo React + ReactDOM +
 *     Tailwind ko CDN se load karta hai; browser mein Babel/runtime compilation nahi hoti.
 *
 * Kaise chalayein (project dependencies install honi chahiye):
 *   node scripts/export-standalone.mjs
 *
 * Result:
 *   standalone-export/index.html  -> seedha double-click / browser mein khol do
 *   (WebSocket wahi 127.0.0.1:8788/ws se connect karega jaisा dev mein karta hai)
 *
 * Ye script tumhare src/ ki KOI file nahi chhedta - sirf padhta hai aur ek
 * naya standalone-export/ folder banata hai.
 * ============================================================================
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SOURCE_FILE = path.join(PROJECT_ROOT, "src/app/option-chain/page.tsx");
const OUT_DIR = path.join(PROJECT_ROOT, "standalone-export");
const OUT_FILE = path.join(OUT_DIR, "index.html");

// Default WS URL if the exported page can't find window.NEXT_PUBLIC_WS_URL.
// Edit here if your engine runs on a different host/port.
const DEFAULT_WS_URL = "ws://127.0.0.1:8788/ws";

function fail(msg) {
  console.error(`\n[export-standalone] ERROR: ${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync(SOURCE_FILE)) {
  fail(`Source file not found: ${SOURCE_FILE}\nRun this from the project root: node scripts/export-standalone.mjs`);
}

let code = fs.readFileSync(SOURCE_FILE, "utf8");

// ---------------------------------------------------------------------------
// 1. Strip Next.js-specific / module-only syntax that a plain <script type="text/babel">
//    tag can't handle (the previous browser compiler in classic-script mode doesn't rewrite
//    import/export - so we remove them ourselves and wire up equivalents).
// ---------------------------------------------------------------------------

// "use client" directive - meaningless outside Next.js
code = code.replace(/^\s*["']use client["'];?\s*\n/, "");

// import { useState, useEffect, useRef, useCallback } from "react";
code = code.replace(
  /import\s*\{([^}]+)\}\s*from\s*["']react["'];?/,
  (_m, names) => `const {${names}} = React;`
);

// import { Settings, ChevronDown, X, TrendingUp, TrendingDown } from "lucide-react";
// -> replaced with tiny inline SVG stand-ins defined below, so we just drop the import.
code = code.replace(/import\s*\{[^}]+\}\s*from\s*["']lucide-react["'];?\s*\n/, "");

// trailing: import React from "react"; (and the comment above it)
code = code.replace(/\/\/\s*Need to import React for Fragment\s*\nimport React from ["']react["'];?\s*\n?/, "");
code = code.replace(/^\s*import React from ["']react["'];?\s*\n/m, "");

// export default function OptionChainPage() { ... }  ->  function OptionChainPage() { ... }
code = code.replace(/export\s+default\s+function\s+OptionChainPage/, "function OptionChainPage");

// process.env.NEXT_PUBLIC_WS_URL doesn't exist in a plain browser page.
code = code.replace(
  /process\.env\.NEXT_PUBLIC_WS_URL/g,
  `(window.NEXT_PUBLIC_WS_URL)`
);

if (code.includes("import ") || code.includes("export ")) {
  console.warn(
    "[export-standalone] WARNING: leftover import/export statement found after transform.\n" +
    "The exported page.tsx may have changed shape since this script was written - check standalone-export/index.html output manually."
  );
}

// Compile TSX once during export. This removes Babel and the expensive
// in-browser TypeScript/JSX transform from every standalone page load.
const compiled = await transform(code, {
  loader: "tsx",
  jsx: "transform",
  target: "es2017",
  minify: true,
  legalComments: "none",
});

// ---------------------------------------------------------------------------
// 2. Minimal inline icon components (stand-ins for the lucide-react icons
//    actually used on this page). Kept tiny and dependency-free.
// ---------------------------------------------------------------------------
const ICONS_SNIPPET = `
// ---- Inline icon stand-ins (lucide-react not available without npm) ----
function Settings(props) {
  return React.createElement("svg", { viewBox: "0 0 24 24", width: 20, height: 20, fill: "none", stroke: "currentColor", strokeWidth: 2, ...props },
    React.createElement("circle", { cx: 12, cy: 12, r: 3 }),
    React.createElement("path", { d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" })
  );
}
function ChevronDown(props) {
  return React.createElement("svg", { viewBox: "0 0 24 24", width: 16, height: 16, fill: "none", stroke: "currentColor", strokeWidth: 2, ...props },
    React.createElement("polyline", { points: "6 9 12 15 18 9" })
  );
}
function X(props) {
  return React.createElement("svg", { viewBox: "0 0 24 24", width: 18, height: 18, fill: "none", stroke: "currentColor", strokeWidth: 2, ...props },
    React.createElement("line", { x1: 18, y1: 6, x2: 6, y2: 18 }),
    React.createElement("line", { x1: 6, y1: 6, x2: 18, y2: 18 })
  );
}
function TrendingUp(props) {
  return React.createElement("svg", { viewBox: "0 0 24 24", width: 18, height: 18, fill: "none", stroke: "currentColor", strokeWidth: 2, ...props },
    React.createElement("polyline", { points: "23 6 13.5 15.5 8.5 10.5 1 18" }),
    React.createElement("polyline", { points: "17 6 23 6 23 12" })
  );
}
function TrendingDown(props) {
  return React.createElement("svg", { viewBox: "0 0 24 24", width: 18, height: 18, fill: "none", stroke: "currentColor", strokeWidth: 2, ...props },
    React.createElement("polyline", { points: "23 18 13.5 8.5 8.5 13.5 1 6" }),
    React.createElement("polyline", { points: "17 18 23 18 23 12" })
  );
}
`;

// ---------------------------------------------------------------------------
// 3. Assemble the final HTML - everything inlined into ONE file, nothing else
//    to ship. CDN scripts still need internet access to load (that's normal
//    for any web page); no npm install / node_modules / build step required.
// ---------------------------------------------------------------------------
const html = `<!DOCTYPE html>
<!-- BUILD: ${new Date().toISOString()} — if this timestamp looks old in the
     browser's "View Source", the browser is showing a CACHED copy. Hard-reload
     (or open in Incognito, or check "Disable cache" in DevTools > Network) . -->
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Option Chain (Standalone)</title>

<!-- React + ReactDOM (UMD builds - work as plain <script> tags, no bundler). -->
<!-- Pinned to 18.3.1: recent React 19.x point releases stopped shipping a UMD
     build at this path on unpkg (404), so we use the last widely-mirrored
     18.x release instead. It still has everything this page needs
     (hooks, ReactDOM.createRoot, etc). -->
<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>

<!-- Tailwind CDN (play build) - same utility classes the app already uses -->
<script src="https://cdn.tailwindcss.com"></script>

<!-- Optional decorative "sketch" font (opt-in only, toggled in Settings) -->
<link href="https://fonts.googleapis.com/css2?family=Caveat:wght@500;700&display=swap" rel="stylesheet">

<style>
  html, body, #root { height: 100%; margin: 0; background: #f1f5f9; }

  /* Theme variables — mirrors src/app/globals.css. Light is the default;
     [data-theme="dark"] overrides it. Kept in sync manually since this
     standalone build doesn't go through the Next.js/Tailwind CSS pipeline. */
  :root {
    --bg-page: #f1f5f9;
    --bg-panel: #ffffff;
    --bg-panel-alt: #f1f5f9;
    --bg-hover: #e2e8f0;
    --border-color: #cbd5e1;
    --strike-border: #d97706;
    --text-primary: #0f172a;
    --text-secondary: #475569;
    --text-muted: #94a3b8;
    --row-alt-ce: rgba(220, 38, 38, 0.06);
    --row-alt-pe: rgba(22, 163, 74, 0.06);
    --uf-scale: 1;
    --uf-weight: 700;
    --uf-width-scale: 1;
    --uf-height-scale: 1;
  }
  [data-theme="dark"] {
    --bg-page: #0f172a;
    --bg-panel: #1e293b;
    --bg-panel-alt: rgba(51, 65, 85, 0.5);
    --bg-hover: #334155;
    --border-color: #334155;
    --strike-border: #f59e0b;
    --text-primary: #f8fafc;
    --text-secondary: #94a3b8;
    --text-muted: #64748b;
    --row-alt-ce: rgba(127, 29, 29, 0.18);
    --row-alt-pe: rgba(20, 83, 45, 0.18);
  }
  .font-sketch, .font-sketch * { font-family: "Caveat", cursive !important; }
  .font-serif-ui, .font-serif-ui * { font-family: Georgia, "Times New Roman", serif !important; }
  .font-mono-ui, .font-mono-ui * { font-family: "Courier New", ui-monospace, monospace !important; }
</style>
</head>
<body>
<div id="root"></div>

<!--
  Optional: override the WebSocket URL without re-running the export script.
  Uncomment and edit if your engine isn't on 127.0.0.1:8788.
  <script>window.NEXT_PUBLIC_WS_URL = "ws://YOUR_HOST:8788/ws";</script>
-->

<script>
${ICONS_SNIPPET}
console.log("%c[standalone-export] precompiled build: ${new Date().toISOString()}", "color:#22c55e;font-weight:bold");
const DEFAULT_WS_FALLBACK = ${JSON.stringify(DEFAULT_WS_URL)};
window.NEXT_PUBLIC_WS_URL = window.NEXT_PUBLIC_WS_URL || DEFAULT_WS_FALLBACK;
${compiled.code.replace(/<\/script/g, "<\\/script")}
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(React.createElement(OptionChainPage));
</script>
</body>
</html>
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, html, "utf8");

console.log(`\n[export-standalone] Done.`);
console.log(`  -> ${path.relative(PROJECT_ROOT, OUT_FILE)}`);
console.log(`\nOpen it directly in a browser (double-click, or:`);
console.log(`  open standalone-export/index.html      # macOS`);
console.log(`  start standalone-export\\index.html      # Windows`);
console.log(`  xdg-open standalone-export/index.html   # Linux`);
console.log(`\nThe export is precompiled with esbuild. Internet access is needed once, to load`);
console.log(`React and Tailwind from CDN when the page opens.\n`);
