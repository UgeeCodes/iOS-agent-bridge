import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WDAClient } from "../wda/client.js";
import { parseXCUIElementTree } from "../wda/parser.js";
import { screenshot } from "../wda/screenshot.js";

export function registerToolHandlers(server: Server, wda: WDAClient) {
  const elementCache = new Map<
    string,
    { x: number; y: number; width: number; height: number }
  >();

  async function handleStatus() {
    const status = await wda.getStatus();
    return textResult(JSON.stringify(status, null, 2));
  }

  async function handleSnapshot() {
    const tree = await wda.getTree();
    const elements = parseXCUIElementTree(tree);

    elementCache.clear();
    for (const element of elements) {
      elementCache.set(element.ref, {
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
      });
    }

    const outline = elements.map((element) => {
      const label = element.label ? ` "${element.label}"` : "";
      const value = element.value ? ` value="${element.value}"` : "";
      return `[${element.ref}] ${element.type}${label}${value} @${element.x},${element.y}`;
    });

    return textResult(
      outline.length > 0
        ? `Screen Elements:\n${outline.join("\n")}`
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

    await wda.type(text);
    return textResult("Text entered successfully.");
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

  const handlers: Record<string, ToolHandler> = {
    get_status: handleStatus,
    ui_snapshot: handleSnapshot,
    ui_tap: handleTap,
    ui_swipe: handleSwipe,
    ui_type: handleType,
    ui_screenshot: handleScreenshot,
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
        name: "ui_snapshot",
        description:
          "Get a compact outline of visible elements on the current iPhone screen. Returns temporary refs for use with ui_tap.",
        inputSchema: {
          type: "object",
          properties: {},
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
        description: "Type text into the currently focused iPhone element.",
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Text to enter into the focused element.",
            },
          },
          required: ["text"],
          additionalProperties: false,
        },
      },
      {
        name: "ui_screenshot",
        description:
          "Capture an image screenshot of the current iPhone screen.",
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
