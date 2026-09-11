// ─── Types & Interfaces ──────────────────────────────────────────────────────

export interface SnapshotElement {
  ref: string;
  type: string;
  label?: string;
  value?: string;
  identifier?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  enabled: boolean;
  selected?: boolean;
}

export interface ParseOptions {
  includeOffscreen?: boolean;
  screenWidth?: number;
  screenHeight?: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface NodeContext {
  parentLabel?: string;
  parentRect?: Rect;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const INTERACTIVE_TYPES = new Set([
  "Button",
  "TextField",
  "SecureTextField",
  "SearchField",
  "TextView",
  "Cell",
  "Link",
  "Switch",
  "Image",
  "StaticText",
  "Slider",
  "Picker",
  "PickerWheel",
  "SegmentedControl",
  "Tab",
  "TabBar",
  "Key",
]);

// ─── Public API ──────────────────────────────────────────────────────────────

export function parseXCUIElementTree(
  response: unknown,
  options?: ParseOptions,
): SnapshotElement[] {
  const elements: SnapshotElement[] = [];
  const root = unwrapTree(response);
  visitNode(root, elements, options, {});
  return elements;
}

// ─── Tree Traversal ──────────────────────────────────────────────────────────

function unwrapTree(response: unknown): unknown {
  if (!isRecord(response)) return response;

  const value = response.value;
  if (!isRecord(value)) return value ?? response;

  return value.tree ?? value;
}

function visitNode(
  node: unknown,
  elements: SnapshotElement[],
  options?: ParseOptions,
  context?: NodeContext,
): void {
  if (!isRecord(node)) return;

  const rect = parseRect(node.rect);
  const type = stringValue(node.type)?.replace(/^XCUIElementType/, "") ?? "";
  const identifier = stringValue(node.identifier);
  const label = stringValue(node.label) ?? stringValue(node.name) ?? identifier;
  const value = stringValue(node.value);
  const hasContent = Boolean(label || value);

  const visible = options?.includeOffscreen ? true : isVisible(node);
  const inViewport = rect ? isWithinViewport(rect, options) : false;

  // Filter out unlabeled, un-actionable Image elements (purely decorative icons)
  const isMeaningfulImage = type === "Image" && hasContent;

  // Filter redundant StaticText children that duplicate their parent's label and bounds
  const isRedundantText =
    type === "StaticText" &&
    Boolean(
      label &&
      context?.parentLabel &&
      label.trim().toLowerCase() === context.parentLabel.trim().toLowerCase() &&
      rect &&
      context.parentRect &&
      isContainedOrNear(rect, context.parentRect),
    );

  const isInteractiveCandidate =
    type === "Image"
      ? isMeaningfulImage
      : INTERACTIVE_TYPES.has(type) || hasContent;

  if (
    visible &&
    inViewport &&
    rect &&
    rect.width > 0 &&
    rect.height > 0 &&
    isInteractiveCandidate &&
    !isRedundantText
  ) {
    elements.push({
      ref: `e${elements.length + 1}`,
      type: type || "Element",
      label,
      value,
      identifier: identifier !== label ? identifier : undefined,
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      enabled: isEnabled(node),
      selected: isSelected(node) ? true : undefined,
    });
  }

  // Pass down context if this element provides a label for its children
  const nextContext: NodeContext =
    label && rect ? { parentLabel: label, parentRect: rect } : (context ?? {});

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      visitNode(child, elements, options, nextContext);
    }
  }
}

// ─── Node State & Attributes ─────────────────────────────────────────────────

function isVisible(node: Record<string, unknown>): boolean {
  const visible = node.isVisible ?? node.visible;
  return visible !== false && visible !== 0 && visible !== "0";
}

function isEnabled(node: Record<string, unknown>): boolean {
  const enabled = node.isEnabled ?? node.enabled;
  return enabled !== false && enabled !== 0 && enabled !== "0";
}

function isSelected(node: Record<string, unknown>): boolean {
  const selected = node.isSelected ?? node.selected;
  return (
    selected === true ||
    selected === 1 ||
    selected === "1" ||
    selected === "true"
  );
}

// ─── Geometry & Viewport ─────────────────────────────────────────────────────

function parseRect(value: unknown): Rect | undefined {
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

function isWithinViewport(rect: Rect, options?: ParseOptions): boolean {
  if (options?.includeOffscreen) return true;

  // Fully scrolled past top or left
  if (rect.x + rect.width <= 0 || rect.y + rect.height <= 0) {
    return false;
  }

  // Past screen boundaries if provided
  if (options?.screenWidth !== undefined && rect.x >= options.screenWidth) {
    return false;
  }
  if (options?.screenHeight !== undefined && rect.y >= options.screenHeight) {
    return false;
  }

  return true;
}

function isContainedOrNear(child: Rect, parent: Rect, tolerance = 10): boolean {
  return (
    child.x >= parent.x - tolerance &&
    child.y >= parent.y - tolerance &&
    child.x + child.width <= parent.x + parent.width + tolerance &&
    child.y + child.height <= parent.y + parent.height + tolerance
  );
}

// ─── General Utilities ───────────────────────────────────────────────────────

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
