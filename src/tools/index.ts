import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { WDAClient } from "../wda/client.js";
import { parseXCUIElementTree } from "../wda/parser.js";
import { screenshot } from "../wda/screenshot.js";
import { unlockWithPasscode } from "../wda/device.js";

// ─── Types ───────────────────────────────────────────────────────────────────

type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
};

type ToolDef<S extends z.ZodObject> = {
  name: string;
  description: string;
  schema: S;
  handler: (args: z.infer<S>) => Promise<ToolResult>;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function textResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function defineTool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

// ─── Main Registration ──────────────────────────────────────────────────────

export function registerToolHandlers(server: Server, wda: WDAClient) {
  const elementCache = new Map<
    string,
    { x: number; y: number; width: number; height: number }
  >();

  let cachedWindowSize: { width: number; height: number } | null = null;

  async function getScreenSize(): Promise<{
    width: number;
    height: number;
  } | null> {
    if (!cachedWindowSize) {
      try {
        const win = await wda.getWindowSize();
        cachedWindowSize = { width: win.width, height: win.height };
      } catch {}
    }
    return cachedWindowSize;
  }

  // Helper: optionally append a snapshot to a result
  async function maybeSnapshot(
    result: ToolResult,
    snapshotAfter: boolean,
  ): Promise<ToolResult> {
    if (!snapshotAfter) return result;
    const snap = await snapshotHandler({});
    return {
      content: [...result.content, ...(snap.content || [])],
    };
  }

  // Helper: run the snapshot logic (used by ui_snapshot and snapshot_after)
  async function snapshotHandler(args: {
    query?: string;
    max_nodes?: number;
    include_offscreen?: boolean;
  }): Promise<ToolResult> {
    const query =
      typeof args.query === "string" && args.query.trim().length > 0
        ? args.query.trim().toLowerCase()
        : undefined;

    const maxNodes =
      typeof args.max_nodes === "number" && args.max_nodes >= 10
        ? Math.min(Math.floor(args.max_nodes), 600)
        : 250;

    const includeOffscreen = Boolean(args.include_offscreen);

    const [tree, screenSize] = await Promise.all([
      wda.getTree(),
      getScreenSize(),
    ]);

    const allElements = parseXCUIElementTree(tree, {
      includeOffscreen,
      screenWidth: screenSize?.width,
      screenHeight: screenSize?.height,
    });

    elementCache.clear();
    for (const element of allElements) {
      elementCache.set(element.ref, {
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
      });
    }

    let displayed = allElements;
    if (query) {
      displayed = allElements.filter(
        (el) =>
          el.ref.toLowerCase().includes(query) ||
          el.type.toLowerCase().includes(query) ||
          (el.label && el.label.toLowerCase().includes(query)) ||
          (el.value && el.value.toLowerCase().includes(query)) ||
          (el.identifier && el.identifier.toLowerCase().includes(query)),
      );
    }

    const totalMatching = displayed.length;
    const capped = displayed.slice(0, maxNodes);

    const outline = capped.map((element) => {
      const label = element.label ? ` "${element.label}"` : "";
      const value = element.value ? ` value="${element.value}"` : "";
      const flags = [
        element.selected ? "selected" : "",
        !element.enabled ? "disabled" : "",
      ]
        .filter(Boolean)
        .map((f) => ` [${f}]`)
        .join("");
      return `[${element.ref}] ${element.type}${label}${value}${flags} @${element.x},${element.y}`;
    });

    let header = `Screen Elements (${capped.length}`;
    if (totalMatching > capped.length) {
      header += ` of ${totalMatching} matching, capped at ${maxNodes}`;
    }
    header += `):`;

    if (query) {
      header = `Filtered Screen Elements matching "${query}" (${capped.length}`;
      if (totalMatching > capped.length) {
        header += ` of ${totalMatching}, capped at ${maxNodes}`;
      }
      header += `):`;
    }

    return textResult(
      outline.length > 0
        ? `${header}\n${outline.join("\n")}`
        : query
          ? `No screen elements matched query "${query}".`
          : "No visible screen elements found.",
    );
  }

  // ─── Observation Tools ───────────────────────────────────────────────────

  const uiSnapshot = defineTool({
    name: "ui_snapshot",
    description:
      "THE primary way to see the screen. Returns a compact outline of every actionable element " +
      "with a stable ref like [e12]. Act on refs with ui_tap/ui_type — do not guess coordinates. " +
      "Refs are invalidated by the next snapshot. Use `query` to filter a busy screen.",
    schema: z.object({
      query: z
        .string()
        .optional()
        .describe(
          "Case-insensitive filter over element label/value/type, e.g. 'send' or 'Cell'.",
        ),
      max_nodes: z
        .int()
        .min(10)
        .max(600)
        .optional()
        .describe("Maximum number of nodes to return (default 250)."),
      include_offscreen: z
        .boolean()
        .optional()
        .describe(
          "Include elements outside the visible screen (other pages, below the fold).",
        ),
    }),
    handler: async (args) => snapshotHandler(args),
  });

  const uiScreenshot = defineTool({
    name: "ui_screenshot",
    description:
      "A picture of the current screen. Use when the accessibility tree is not enough — custom-drawn " +
      "UI, images, games, or verifying something looks right. For deciding what to tap, ui_snapshot " +
      "is better. NOTE: tap coordinates are in points, not image pixels.",
    schema: z.object({}),
    handler: async () => {
      const result = await screenshot(wda);
      return {
        content: [
          {
            type: "image" as const,
            data: result.base64,
            mimeType: "image/png",
          },
          { type: "text" as const, text: result.note },
        ],
      };
    },
  });

  // ─── Action Tools ────────────────────────────────────────────────────────

  const uiTap = defineTool({
    name: "ui_tap",
    description: "Tap an element using a ref from the most recent ui_snapshot.",
    schema: z.object({
      ref: z
        .string()
        .describe("Element ref from ui_snapshot, such as e1 or e2."),
      snapshot_after: z
        .boolean()
        .optional()
        .describe("Return a ui_snapshot immediately after the action."),
    }),
    handler: async ({ ref, snapshot_after }) => {
      const coordinates = elementCache.get(ref);
      if (!coordinates) {
        return errorResult(`Ref ${ref} not found. Run ui_snapshot first.`);
      }

      await wda.tap(coordinates.x, coordinates.y);
      elementCache.clear();
      return maybeSnapshot(
        textResult(
          `Tapped ${ref} at (${coordinates.x}, ${coordinates.y}). Run ui_snapshot to see the updated screen.`,
        ),
        snapshot_after ?? false,
      );
    },
  });

  const uiTapPoint = defineTool({
    name: "ui_tap_point",
    description:
      "Escape hatch: tap an absolute point in POINTS (not pixels). Only use when an element has no accessibility entry — prefer ui_tap with a ref.",
    schema: z.object({
      x: z.number().describe("X coordinate in screen points."),
      y: z.number().describe("Y coordinate in screen points."),
      snapshot_after: z
        .boolean()
        .optional()
        .describe("Return a ui_snapshot immediately after the action."),
    }),
    handler: async ({ x, y, snapshot_after }) => {
      await wda.tap(Math.round(x), Math.round(y));
      elementCache.clear();
      return maybeSnapshot(
        textResult(
          `Tapped point (${Math.round(x)}, ${Math.round(y)}) in points. Run ui_snapshot to see the updated screen.`,
        ),
        snapshot_after ?? false,
      );
    },
  });

  const uiLongPress = defineTool({
    name: "ui_long_press",
    description:
      "Press and hold an element — opens iOS context menus, enters home screen edit mode, etc.",
    schema: z.object({
      ref: z
        .string()
        .describe("Element ref from ui_snapshot, such as e1 or e2."),
      ms: z
        .int()
        .min(300)
        .max(5000)
        .optional()
        .describe("Duration to hold in milliseconds (default 1200)."),
      snapshot_after: z
        .boolean()
        .optional()
        .describe("Return a ui_snapshot immediately after the action."),
    }),
    handler: async ({ ref, ms, snapshot_after }) => {
      const coordinates = elementCache.get(ref);
      if (!coordinates) {
        return errorResult(`Ref ${ref} not found. Run ui_snapshot first.`);
      }

      const durationMs = ms ?? 1200;
      await wda.touchAndHold(coordinates.x, coordinates.y, durationMs);
      elementCache.clear();
      return maybeSnapshot(
        textResult(
          `Long pressed ${ref} for ${durationMs}ms at (${coordinates.x}, ${coordinates.y}). Run ui_snapshot to see the updated screen.`,
        ),
        snapshot_after ?? false,
      );
    },
  });

  const uiSwipe = defineTool({
    name: "ui_swipe",
    description:
      "Swipe in a direction. `direction` is the way the FINGER moves: 'up' scrolls further down a " +
      "page, 'left' moves to the next home screen page. Optionally scope to a scrollable element " +
      "with `ref`, and repeat with `times`.",
    schema: z.object({
      direction: z
        .enum(["up", "down", "left", "right"])
        .describe(
          "The direction the finger moves: 'up' (scroll down), 'down' (scroll up), 'left' (swipe next), 'right' (swipe previous).",
        ),
      ref: z
        .string()
        .optional()
        .describe(
          "Optional element ref from ui_snapshot to scope the swipe within.",
        ),
      times: z
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Number of times to repeat the swipe (default 1)."),
      snapshot_after: z
        .boolean()
        .optional()
        .describe("Return a ui_snapshot immediately after the action."),
    }),
    handler: async ({ direction, ref, times: rawTimes, snapshot_after }) => {
      const times = rawTimes ?? 1;

      let cx: number;
      let cy: number;
      let deltaX: number;
      let deltaY: number;

      if (typeof ref === "string") {
        const el = elementCache.get(ref);
        if (!el) {
          return errorResult(`Ref ${ref} not found. Run ui_snapshot first.`);
        }
        cx = el.x;
        cy = el.y;
        deltaX = Math.max(Math.min(el.width * 0.35, 200), 20);
        deltaY = Math.max(Math.min(el.height * 0.35, 200), 20);
      } else {
        const win = await wda.getWindowSize();
        cx = Math.round(win.width / 2);
        cy = Math.round(win.height / 2);
        deltaX = Math.round(win.width * 0.35);
        deltaY = Math.round(win.height * 0.3);
      }

      let startX = cx;
      let startY = cy;
      let endX = cx;
      let endY = cy;

      switch (direction) {
        case "up":
          startY = cy + deltaY;
          endY = cy - deltaY;
          break;
        case "down":
          startY = cy - deltaY;
          endY = cy + deltaY;
          break;
        case "left":
          startX = cx + deltaX;
          endX = cx - deltaX;
          break;
        case "right":
          startX = cx - deltaX;
          endX = cx + deltaX;
          break;
      }

      for (let i = 0; i < times; i++) {
        await wda.swipe(startX, startY, endX, endY);
        if (i < times - 1) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }

      elementCache.clear();
      const scope = typeof ref === "string" ? ` on ${ref}` : "";
      return maybeSnapshot(
        textResult(
          `Swiped ${direction}${scope} (${times}x). Run ui_snapshot to see the updated screen.`,
        ),
        snapshot_after ?? false,
      );
    },
  });

  const uiType = defineTool({
    name: "ui_type",
    description:
      "Type into a text field. Pass `ref` to tap that field first (recommended), or omit to type " +
      "into whatever already has focus. Use submit=true to press return afterwards.",
    schema: z.object({
      text: z.string().describe("Text to enter into the text field."),
      ref: z
        .string()
        .optional()
        .describe(
          "Optional element ref from ui_snapshot to focus before typing.",
        ),
      submit: z
        .boolean()
        .optional()
        .describe(
          "Whether to press Return/Enter after typing the text (e.g. to submit a search or send).",
        ),
      snapshot_after: z
        .boolean()
        .optional()
        .describe("Return a ui_snapshot immediately after the action."),
    }),
    handler: async ({ text, ref, submit, snapshot_after }) => {
      if (typeof ref === "string") {
        const coordinates = elementCache.get(ref);
        if (!coordinates) {
          return errorResult(`Ref ${ref} not found. Run ui_snapshot first.`);
        }
        await wda.tap(coordinates.x, coordinates.y);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      const payload = submit === true ? `${text}\n` : text;
      await wda.type(payload);
      elementCache.clear();

      const target = typeof ref === "string" ? ` into ${ref}` : "";
      const submitted = submit === true ? " and submitted" : "";
      return maybeSnapshot(
        textResult(
          `Typed${target}${submitted}. Run ui_snapshot to see the updated screen.`,
        ),
        snapshot_after ?? false,
      );
    },
  });

  // ─── Device Tools ────────────────────────────────────────────────────────

  const COMMON_APP_ALIASES: Record<string, string> = {
    messages: "com.apple.MobileSMS",
    sms: "com.apple.MobileSMS",
    safari: "com.apple.mobilesafari",
    settings: "com.apple.Preferences",
    photos: "com.apple.mobileslideshow",
    camera: "com.apple.camera",
    maps: "com.apple.Maps",
    notes: "com.apple.mobilenotes",
    calendar: "com.apple.mobilecal",
    reminders: "com.apple.reminders",
    music: "com.apple.Music",
    mail: "com.apple.mobilemail",
    phone: "com.apple.mobilephone",
    clock: "com.apple.mobiletimer",
    appstore: "com.apple.AppStore",
    files: "com.apple.DocumentsApp",
    calculator: "com.apple.calculator",
    weather: "com.apple.weather",
    contacts: "com.apple.MobileAddressBook",
  };

  const deviceStatus = defineTool({
    name: "device_status",
    description:
      "Check connectivity to the iOS device WebDriverAgent runner, screen lock state, and foreground app.",
    schema: z.object({}),
    handler: async () => {
      const [status, locked, activeApp] = await Promise.all([
        wda.getStatus().catch((e) => ({ error: String(e) })),
        wda.isLocked().catch(() => "unknown"),
        wda.getActiveApp().catch(() => ({ bundleId: "unknown", pid: 0 })),
      ]);
      return textResult(
        JSON.stringify(
          typeof status === "object" && status !== null
            ? { ...status, deviceLocked: locked, activeApp }
            : { status, deviceLocked: locked, activeApp },
          null,
          2,
        ),
      );
    },
  });

  const deviceOpenApp = defineTool({
    name: "device_open_app",
    description:
      "Open an iOS app by bundle ID (e.g. 'com.apple.MobileSMS') or common name " +
      "('messages', 'safari', 'settings', 'notes', 'photos', 'camera', 'maps', etc.).",
    schema: z.object({
      bundle_id: z
        .string()
        .describe(
          "Bundle identifier (e.g. 'com.apple.MobileSMS') or common name ('messages', 'safari', 'settings').",
        ),
      snapshot_after: z
        .boolean()
        .optional()
        .describe("Return a ui_snapshot immediately after launching the app."),
    }),
    handler: async ({ bundle_id, snapshot_after }) => {
      const normalized = bundle_id.trim().toLowerCase();
      const targetBundleId = COMMON_APP_ALIASES[normalized] ?? bundle_id.trim();

      await wda.launchApp(targetBundleId);
      elementCache.clear();
      await new Promise((resolve) => setTimeout(resolve, 800));

      return maybeSnapshot(
        textResult(
          `Launched app "${targetBundleId}". Run ui_snapshot to see the updated screen.`,
        ),
        snapshot_after ?? false,
      );
    },
  });

  const deviceLock = defineTool({
    name: "device_lock",
    description:
      "Lock the phone, or wake and unlock it. If the device has a passcode, it is typed on the " +
      "on-screen keypad — set IPHONE_MCP_PASSCODE in the server env so it need not be passed here. " +
      "Face ID cannot be triggered programmatically.",
    schema: z.object({
      action: z
        .enum(["lock", "unlock", "status"])
        .describe(
          "Whether to lock the screen, wake and unlock it, or check lock status.",
        ),
      passcode: z
        .string()
        .optional()
        .describe(
          "Optional 4-10 digit passcode. Omit to use IPHONE_MCP_PASSCODE from the environment.",
        ),
      snapshot_after: z
        .boolean()
        .optional()
        .describe("Return a ui_snapshot immediately after unlocking."),
    }),
    handler: async ({ action, passcode, snapshot_after }) => {
      if (action === "lock") {
        await wda.lock();
        elementCache.clear();
        return textResult("Device locked.");
      }

      if (action === "status") {
        const locked = await wda.isLocked().catch(() => "unknown");
        return textResult(JSON.stringify({ deviceLocked: locked }, null, 2));
      }

      const result = await unlockWithPasscode(wda, passcode);
      elementCache.clear();
      return maybeSnapshot(textResult(result), snapshot_after ?? false);
    },
  });

  const devicePressButton = defineTool({
    name: "device_press_button",
    description:
      "Press home (also exits edit mode / closes menus), or the volume buttons.",
    schema: z.object({
      name: z
        .enum(["home", "volumeup", "volumedown"])
        .describe(
          "The hardware button to press: 'home', 'volumeup', or 'volumedown'.",
        ),
      snapshot_after: z
        .boolean()
        .optional()
        .describe(
          "Return a ui_snapshot immediately after pressing the button.",
        ),
    }),
    handler: async ({ name, snapshot_after }) => {
      await wda.pressButton(name);
      elementCache.clear();
      return maybeSnapshot(
        textResult(
          `Pressed ${name} button. Run ui_snapshot to see the updated screen.`,
        ),
        snapshot_after ?? false,
      );
    },
  });

  // ─── Tool Registry ─────────────────────────────────────────────────────

  const allTools = [
    // Observation
    uiSnapshot,
    uiScreenshot,
    // Action
    uiTap,
    uiTapPoint,
    uiLongPress,
    uiSwipe,
    uiType,
    // Device
    deviceStatus,
    deviceOpenApp,
    deviceLock,
    devicePressButton,
  ] as ToolDef<z.ZodObject>[];

  const handlerMap = new Map(allTools.map((t) => [t.name, t]));

  // ─── MCP Request Handlers ──────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.schema) as {
        type: "object";
        properties?: Record<string, object>;
        required?: string[];
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const tool = handlerMap.get(name);

    if (!tool) {
      return errorResult(`Tool not found: ${name}`);
    }

    try {
      const parsed = tool.schema.parse(rawArgs ?? {});
      return await tool.handler(parsed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(message);
    }
  });
}
