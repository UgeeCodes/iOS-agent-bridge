export interface SnapshotElement {
  ref: string;
  type: string;
  label?: string;
  value?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  enabled: boolean;
}

const INTERACTIVE_TYPES = new Set([
  "Button",
  "TextField",
  "SecureTextField",
  "Cell",
  "Link",
  "Switch",
  "Image",
  "StaticText",
]);

export function parseXCUIElementTree(response: unknown): SnapshotElement[] {
  const elements: SnapshotElement[] = [];
  visitNode(unwrapTree(response), elements);
  return elements;
}

function visitNode(node: unknown, elements: SnapshotElement[]): void {
  if (!isRecord(node)) return;

  const rect = parseRect(node.rect);
  const type = stringValue(node.type)?.replace(/^XCUIElementType/, "") ?? "";
  const label = stringValue(node.label) ?? stringValue(node.name);
  const value = stringValue(node.value);
  const hasContent = Boolean(label || value);

  if (
    isVisible(node) &&
    rect &&
    rect.width > 0 &&
    rect.height > 0 &&
    (INTERACTIVE_TYPES.has(type) || hasContent)
  ) {
    elements.push({
      ref: `e${elements.length + 1}`,
      type: type || "Element",
      label,
      value,
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      enabled: isEnabled(node),
    });
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      visitNode(child, elements);
    }
  }
}

function unwrapTree(response: unknown): unknown {
  if (!isRecord(response)) return response;

  const value = response.value;
  if (!isRecord(value)) return value ?? response;

  return value.tree ?? value;
}

function isVisible(node: Record<string, unknown>): boolean {
  const visible = node.isVisible ?? node.visible;
  return visible !== false && visible !== 0 && visible !== "0";
}

function isEnabled(node: Record<string, unknown>): boolean {
  const enabled = node.isEnabled ?? node.enabled;
  return enabled !== false && enabled !== 0 && enabled !== "0";
}

function parseRect(value: unknown) {
  if (!isRecord(value)) return undefined;

  const { x, y, width, height } = value;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return undefined;
  }

  return { x, y, width, height };
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
