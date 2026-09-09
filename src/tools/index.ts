import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WDAClient } from "../wda/client.js";
import { parseXCUIElementTree } from "../wda/parser.js";
import { screenshot } from "../wda/screenshot.js";
import {
  ensureHealthy,
  ensureUnlocked,
  unlockWithPasscode,
} from "../wda/device.js";

export function registerToolHandlers(server: Server, wda: WDAClient) {
  const elementCache = new Map<
    string,
    { x: number; y: number; width: number; height: number }
  >();

  async function handleStatus() {
    const [status, locked] = await Promise.all([
      wda.getStatus().catch((e) => ({ error: String(e) })),
      wda.isLocked().catch(() => "unknown"),
    ]);
    return textResult(
      JSON.stringify(
        typeof status === "object" && status !== null
          ? { ...status, deviceLocked: locked }
          : { status, deviceLocked: locked },
        null,
        2,
      ),
    );
  }

  async function handleSnapshot(args: ToolArguments) {
    const query =
      typeof args.query === "string" && args.query.trim().length > 0
        ? args.query.trim().toLowerCase()
        : undefined;

    const maxNodes =
      typeof args.max_nodes === "number" && args.max_nodes >= 10
        ? Math.min(Math.floor(args.max_nodes), 600)
        : 250;

    const includeOffscreen = Boolean(args.include_offscreen);

    const tree = await wda.getTree();
    const allElements = parseXCUIElementTree(tree, { includeOffscreen });

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
          (el.value && el.value.toLowerCase().includes(query)),
      );
    }

    const totalMatching = displayed.length;
    const capped = displayed.slice(0, maxNodes);

    const outline = capped.map((element) => {
      const label = element.label ? ` "${element.label}"` : "";
      const value = element.value ? ` value="${element.value}"` : "";
      return `[${element.ref}] ${element.type}${label}${value} @${element.x},${element.y}`;
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

  async function handleTap(args: ToolArguments) {
    const ref = args.ref;
    if (typeof ref !== "string") {
      throw new Error("ui_tap requires a string ref.");
    }

    const coordinates = elementCache.get(ref);
    if (!coordinates) {
      throw new Error(`Ref ${ref} not found. Run ui_snapshot first.`);
    }

    await wda.tap(coordinates.x, coordinates.y);
    elementCache.clear();
    return textResult(
      `Tapped ${ref} at (${coordinates.x}, ${coordinates.y}). Run ui_snapshot to see the updated screen.`,
    );
  }

  async function handleTapPoint(args: ToolArguments) {
    const x = args.x;
    const y = args.y;
    if (typeof x !== "number" || typeof y !== "number") {
      throw new Error(
        "ui_tap_point requires numeric x and y coordinates in points.",
      );
    }

    await wda.tap(Math.round(x), Math.round(y));
    elementCache.clear();
    return textResult(
      `Tapped point (${Math.round(x)}, ${Math.round(y)}) in points. Run ui_snapshot to see the updated screen.`,
    );
  }

  async function handleSwipe(args: ToolArguments) {
    const direction = args.direction;
    if (
      typeof direction !== "string" ||
      !["up", "down", "left", "right"].includes(direction)
    ) {
      throw new Error(
        "ui_swipe requires a direction: 'up', 'down', 'left', or 'right'.",
      );
    }

    const times =
      typeof args.times === "number" && args.times > 0
        ? Math.min(Math.floor(args.times), 10)
        : 1;

    let cx: number;
    let cy: number;
    let deltaX: number;
    let deltaY: number;

    if (typeof args.ref === "string") {
      const el = elementCache.get(args.ref);
      if (!el) {
        throw new Error(`Ref ${args.ref} not found. Run ui_snapshot first.`);
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
    const scope = typeof args.ref === "string" ? ` on ${args.ref}` : "";
    return textResult(
      `Swiped ${direction}${scope} (${times}x). Run ui_snapshot to see the updated screen.`,
    );
  }

  async function handleType(args: ToolArguments) {
    const text = args.text;
    if (typeof text !== "string") {
      throw new Error("ui_type requires a text string.");
    }

    if (typeof args.ref === "string") {
      const coordinates = elementCache.get(args.ref);
      if (!coordinates) {
        throw new Error(`Ref ${args.ref} not found. Run ui_snapshot first.`);
      }
      await wda.tap(coordinates.x, coordinates.y);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const payload = args.submit === true ? `${text}\n` : text;
    await wda.type(payload);
    elementCache.clear();

    const target = typeof args.ref === "string" ? ` into ${args.ref}` : "";
    const submitted = args.submit === true ? " and submitted" : "";
    return textResult(
      `Typed${target}${submitted}. Run ui_snapshot to see the updated screen.`,
    );
  }

  async function handleScreenshot() {
    const result = await screenshot(wda);
    return {
      content: [
        {
          type: "image" as const,
          data: result.base64,
          mimeType: "image/png",
        },
        {
          type: "text" as const,
          text: result.note,
        },
      ],
    };
  }

  async function handleUnlock(args: ToolArguments) {
    const passcode =
      typeof args.passcode === "string" ? args.passcode : undefined;
    const result = await unlockWithPasscode(wda, passcode);
    elementCache.clear();
    return textResult(result);
  }

  const handlers: Record<string, ToolHandler> = {
    get_status: handleStatus,
    ui_snapshot: handleSnapshot,
    ui_tap: handleTap,
    ui_tap_point: handleTapPoint,
    ui_swipe: handleSwipe,
    ui_type: handleType,
    ui_screenshot: handleScreenshot,
    ui_unlock: handleUnlock,
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "get_status",
        description:
          "Check connectivity to the iOS device WebDriverAgent runner.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "ui_unlock",
        description:
          "Unlock the iPhone with an optional passcode. If passcode is omitted, uses IPHONE_MCP_PASSCODE from the environment or performs a wake/swipe unlock on passcode-free devices.",
        inputSchema: {
          type: "object",
          properties: {
            passcode: {
              type: "string",
              description: "Optional 4-10 digit device passcode.",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "ui_snapshot",
        description:
          "THE primary way to see the screen. Returns a compact outline of every actionable element " +
          "with a stable ref like [e12]. Act on refs with ui_tap/ui_type — do not guess coordinates. " +
          "Refs are invalidated by the next snapshot. Use `query` to filter a busy screen.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Case-insensitive filter over element label/value/type, e.g. 'send' or 'Cell'.",
            },
            max_nodes: {
              type: "integer",
              minimum: 10,
              maximum: 600,
              default: 250,
              description: "Maximum number of nodes to return (default 250).",
            },
            include_offscreen: {
              type: "boolean",
              default: false,
              description:
                "Include elements outside the visible screen (other pages, below the fold).",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "ui_tap",
        description:
          "Tap an element using a ref from the most recent ui_snapshot.",
        inputSchema: {
          type: "object",
          properties: {
            ref: {
              type: "string",
              description: "Element ref from ui_snapshot, such as e1 or e2.",
            },
          },
          required: ["ref"],
          additionalProperties: false,
        },
      },
      {
        name: "ui_tap_point",
        description:
          "Escape hatch: tap an absolute point in POINTS (not pixels). Only use when an element has no accessibility entry — prefer ui_tap with a ref.",
        inputSchema: {
          type: "object",
          properties: {
            x: {
              type: "number",
              description: "X coordinate in screen points.",
            },
            y: {
              type: "number",
              description: "Y coordinate in screen points.",
            },
          },
          required: ["x", "y"],
          additionalProperties: false,
        },
      },
      {
        name: "ui_swipe",
        description:
          "Swipe in a direction. `direction` is the way the FINGER moves: 'up' scrolls further down a " +
          "page, 'left' moves to the next home screen page. Optionally scope to a scrollable element " +
          "with `ref`, and repeat with `times`.",
        inputSchema: {
          type: "object",
          properties: {
            direction: {
              type: "string",
              enum: ["up", "down", "left", "right"],
              description:
                "The direction the finger moves: 'up' (scroll down), 'down' (scroll up), 'left' (swipe next), 'right' (swipe previous).",
            },
            ref: {
              type: "string",
              description:
                "Optional element ref from ui_snapshot to scope the swipe within.",
            },
            times: {
              type: "integer",
              minimum: 1,
              maximum: 10,
              description: "Number of times to repeat the swipe (default 1).",
            },
          },
          required: ["direction"],
          additionalProperties: false,
        },
      },
      {
        name: "ui_type",
        description:
          "Type into a text field. Pass `ref` to tap that field first (recommended), or omit to type " +
          "into whatever already has focus. Use submit=true to press return afterwards.",
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Text to enter into the text field.",
            },
            ref: {
              type: "string",
              description:
                "Optional element ref from ui_snapshot to focus before typing.",
            },
            submit: {
              type: "boolean",
              default: false,
              description:
                "Whether to press Return/Enter after typing the text (e.g. to submit a search or send).",
            },
          },
          required: ["text"],
          additionalProperties: false,
        },
      },
      {
        name: "ui_screenshot",
        description:
          "A picture of the current screen. Use when the accessibility tree is not enough — custom-drawn " +
          "UI, images, games, or verifying something looks right. For deciding what to tap, ui_snapshot " +
          "is better. NOTE: tap coordinates are in points, not image pixels.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    const handler = handlers[request.params.name];

    if (!handler) {
      throw new Error(`Tool not found: ${request.params.name}`);
    }

    return handler(args);
  });
}

type ToolArguments = Record<string, unknown>;
type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
};
type ToolHandler = (args: ToolArguments) => Promise<ToolResult>;

function textResult(text: string): ToolResult {
  return {
    content: [{ type: "text" as const, text }],
  };
}
