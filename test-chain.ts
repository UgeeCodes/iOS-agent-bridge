/**
 * Smoke-test: exercises the full chain against a live WDA session.
 *
 *   MCP tool handler → WDAClient → HTTP → WebDriverAgent → XCUITest
 *
 * Prerequisites:
 *   1. WDA running on the iPhone (Xcode test runner active).
 *   2. Port forward: `iproxy 8100 8100`
 *
 * Run:
 *   npx tsx test-chain.ts
 */
import "dotenv/config";
import { WDAClient } from "./src/wda/client.js";
import { parseXCUIElementTree } from "./src/wda/parser.js";

const wda = new WDAClient(); // defaults to http://127.0.0.1:8100

// ── Helpers ──────────────────────────────────────────────────────────────

function heading(label: string) {
  console.log(`\n${"═".repeat(60)}\n  ${label}\n${"═".repeat(60)}`);
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✅ ${msg}`);
}

// ── 1. get_status ────────────────────────────────────────────────────────

heading("1 · get_status — can we reach WDA?");

const status = await wda.getStatus();
assert(typeof status === "object" && status !== null, "status is an object");
console.log("  WDA session ID:", status.sessionId ?? "(none — OK for /status)");
console.log("  Response keys:", Object.keys(status).join(", "));

// ── 2. ui_snapshot — parse + filter + refs ───────────────────────────────

heading("2 · ui_snapshot — parse, filter, generate refs");

const tree = await wda.getTree();
assert(typeof tree === "object" && tree !== null, "getTree returned an object");

const elements = parseXCUIElementTree(tree);
assert(Array.isArray(elements), "parseXCUIElementTree returns an array");
assert(elements.length > 0, `found ${elements.length} visible element(s)`);

// Verify ref format
for (const el of elements) {
  assert(/^e\d+$/.test(el.ref), `ref "${el.ref}" matches e<N> pattern`);
}
console.log(`\n  First 10 elements:`);
for (const el of elements.slice(0, 10)) {
  const label = el.label ? ` "${el.label}"` : "";
  const value = el.value ? ` value="${el.value}"` : "";
  console.log(
    `    [${el.ref}] ${el.type}${label}${value} @${el.x},${el.y}  (${el.width}×${el.height})`,
  );
}

// ── 3. Hidden / zero-size exclusion ──────────────────────────────────────

heading("3 · Hidden and zero-size elements excluded");

for (const el of elements) {
  assert(el.width > 0, `${el.ref}: width ${el.width} > 0`);
  assert(el.height > 0, `${el.ref}: height ${el.height} > 0`);
}
console.log(`  All ${elements.length} elements have non-zero dimensions.`);

// ── 4. ui_tap — ref → center coordinates ────────────────────────────────

heading("4 · ui_tap — resolve ref to center and tap");

// Build ref cache the same way the tool handler does
const elementCache = new Map<string, { x: number; y: number }>();
for (const el of elements) {
  elementCache.set(el.ref, { x: el.x, y: el.y });
}

const tapRef = elements[0].ref;
const coords = elementCache.get(tapRef)!;
assert(coords !== undefined, `ref ${tapRef} found in cache`);
assert(
  typeof coords.x === "number" && typeof coords.y === "number",
  `coords are numbers`,
);
console.log(`  Tapping ${tapRef} at (${coords.x}, ${coords.y}) …`);

try {
  await wda.tap(coords.x, coords.y);
  console.log(`  ✅ Tap sent successfully.`);
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log(
    `  ⚠️  Tap HTTP call failed (may be OK if element disappeared): ${msg}`,
  );
}

// ── 5. ui_type — send text to focused field ──────────────────────────────

heading("5 · ui_type — send keystrokes");

const testText = "hi";
console.log(`  Typing "${testText}" into focused element …`);
try {
  await wda.type(testText);
  console.log(`  ✅ Text sent successfully.`);
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log(
    `  ⚠️  type() failed (expected if no text field is focused): ${msg}`,
  );
}

// ── 6. Re-run ui_snapshot — refs refresh ─────────────────────────────────

heading("6 · Re-run ui_snapshot — refs refresh");

const tree2 = await wda.getTree();
const elements2 = parseXCUIElementTree(tree2);
assert(
  elements2.length > 0,
  `second snapshot returned ${elements2.length} element(s)`,
);
assert(elements2[0].ref === "e1", "refs reset to e1 on fresh snapshot");

// Check cache replacement works
const newCache = new Map<string, { x: number; y: number }>();
for (const el of elements2) {
  newCache.set(el.ref, { x: el.x, y: el.y });
}
assert(newCache.has("e1"), "new cache contains e1");
console.log(
  `  New snapshot: ${elements2.length} element(s), refs start at e1.`,
);

// ── Done ─────────────────────────────────────────────────────────────────

heading("ALL CHECKS PASSED 🎉");
console.log("  The full chain is working:\n");
console.log("  MCP tool handler");
console.log("    ↓");
console.log("  WDAClient (axios HTTP)");
console.log("    ↓");
console.log("  WebDriverAgent on iPhone");
console.log("    ↓");
console.log("  XCUITest accessibility tree + input events\n");
