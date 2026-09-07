import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WDAClient } from "../wda/client.js";
import { parseXCUIElementTree } from "../wda/parser.js";

export function registerToolHandlers(server: Server, wda: WDAClient) {
  const elementCache = new Map<string, { x: number; y: number }>();

  async function handleStatus() {
    const status = await wda.getStatus();
    return textResult(JSON.stringify(status, null, 2));
  }

  async function handleSnapshot() {
    const tree = await wda.getTree();
    const elements = parseXCUIElementTree(tree);

    elementCache.clear();
    for (const element of elements) {
      elementCache.set(element.ref, { x: element.x, y: element.y });
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

  async function handleType(args: ToolArguments) {
    const text = args.text;
    if (typeof text !== "string") {
      throw new Error("ui_type requires a text string.");
    }

    await wda.type(text);
    return textResult("Text entered successfully.");
  }

  const handlers: Record<string, ToolHandler> = {
    get_status: handleStatus,
    ui_snapshot: handleSnapshot,
    ui_tap: handleTap,
    ui_type: handleType,
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
type ToolHandler = (args: ToolArguments) => Promise<TextResult>;
type TextResult = ReturnType<typeof textResult>;

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}
