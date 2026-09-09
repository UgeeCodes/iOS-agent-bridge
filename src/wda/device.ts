import { WDAClient } from "./client.js";
import { parseXCUIElementTree, SnapshotElement } from "./parser.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getElements(wda: WDAClient): Promise<SnapshotElement[]> {
  const tree = await wda.getTree();
  return parseXCUIElementTree(tree);
}

/** Does this error smell like "the phone locked itself or lost authorization"? */
export function isAuthOrLockError(e: unknown): boolean {
  const msg = `${(e as any)?.response?.data?.value?.message ?? ""} ${(e as any)?.wdaError ?? ""} ${(e as Error)?.message ?? ""}`;
  return /not authorized for performing ui testing|local\.pid\.0|is not running|stale element reference|screen gets unlocked/i.test(
    msg,
  );
}

export function configuredPasscode(): string | undefined {
  const p =
    process.env.IPHONE_MCP_PASSCODE?.trim() || process.env.PASSCODE?.trim();
  return p || undefined;
}

/**
 * Unlock a passcode-protected device by tapping the on-screen keypad.
 *
 * WDA's own /wda/unlock only wakes and swipes up — it cannot pass a passcode.
 * We drive the keypad the same way: snapshot, find the Key elements, tap them.
 */
export async function unlockWithPasscode(
  wda: WDAClient,
  code?: string,
): Promise<string> {
  const passcode = code ?? configuredPasscode();
  if (!passcode || !/^\d{4,10}$/.test(passcode)) {
    throw new Error(
      "Passcode must be 4-10 digits. Provide it as an argument or set IPHONE_MCP_PASSCODE in .env.",
    );
  }

  if (!(await wda.isLocked().catch(() => true))) {
    return "Already unlocked.";
  }

  // /wda/unlock wakes the display and swipes up to reveal keypad
  await wda.unlock().catch(() => {});
  await sleep(900);

  let cur = await getElements(wda).catch(() => []);
  if (!cur.some((r) => r.type === "Key")) {
    const win = await wda.getWindowSize();
    // Swipe up from near bottom to reveal passcode screen
    await wda.swipe(
      win.width / 2,
      win.height - 20,
      win.width / 2,
      win.height * 0.35,
      350,
    );
    await sleep(1300);
    cur = await getElements(wda).catch(() => []);
  }

  if (!cur.some((r) => r.type === "Key")) {
    throw new Error(
      "Could not reach the passcode keypad. Take a ui_screenshot to see the current lock screen.",
    );
  }

  // Check progress and clear any stale entered digits
  const field = cur.find((r) => r.type === "SecureTextField");
  const progress = /(\d+)\s+of\s+(\d+)\s+values entered/i.exec(
    field?.value ?? "",
  );
  if (progress) {
    const entered = Number(progress[1]);
    const expected = Number(progress[2]);
    if (entered > 0) {
      const del = cur.find((r) => /^delete$/i.test(r.label?.trim() ?? ""));
      if (del) {
        for (let i = 0; i < entered; i++) {
          await wda.tap(del.x, del.y);
          await sleep(180);
        }
        cur = await getElements(wda);
      }
    }
    if (passcode.length !== expected) {
      throw new Error(
        `This device uses a ${expected}-digit passcode but the one provided has ${passcode.length} digits. ` +
          `Aborted to prevent failed passcode lockout.`,
      );
    }
  }

  // Tap each digit key
  for (const digit of passcode) {
    const key = cur.find((r) => r.type === "Key" && r.label?.trim() === digit);
    if (!key) {
      throw new Error(`Passcode key "${digit}" not found on the keypad.`);
    }
    await wda.tap(key.x, key.y);
    await sleep(220);
  }

  await sleep(1500);
  const stillLocked = await wda.isLocked().catch(() => true);
  if (stillLocked) {
    return "Entered the passcode but the device still reports locked — the passcode may be wrong.";
  }

  wda.resetSession();
  return "Unlocked successfully.";
}

/**
 * Make sure the phone is awake and authorized. Cheap no-op when already unlocked.
 */
export async function ensureUnlocked(
  wda: WDAClient,
  code?: string,
): Promise<boolean> {
  let locked: boolean;
  try {
    locked = await wda.isLocked();
  } catch {
    locked = true;
  }

  if (!locked) return true;

  const passcode = code ?? configuredPasscode();
  if (!passcode) {
    // Plain wake and swipe for devices without passcode
    await wda.unlock().catch(() => {});
    await sleep(600);
    return !(await wda.isLocked().catch(() => true));
  }

  wda.resetSession();
  await unlockWithPasscode(wda, passcode).catch(() => {});
  return !(await wda.isLocked().catch(() => true));
}

/**
 * Confirm the runner can drive the device, escalating as needed:
 * probe activeApp -> unlock -> refresh session.
 */
export async function ensureHealthy(
  wda: WDAClient,
  code?: string,
): Promise<void> {
  try {
    await wda.getActiveApp();
    return;
  } catch (e) {
    if (!isAuthOrLockError(e)) throw e;
  }

  await ensureUnlocked(wda, code);
  try {
    await wda.getActiveApp();
    return;
  } catch (e) {
    if (!isAuthOrLockError(e)) throw e;
  }

  // Reset session and re-attempt
  wda.resetSession();
  await ensureUnlocked(wda, code);
  await wda.getActiveApp();
}
