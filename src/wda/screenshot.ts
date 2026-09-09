import { writeFile, readFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { spawn } from "child_process";
import type { WDAClient } from "./client.js";

export interface ScreenshotResult {
  base64: string;
  note: string;
}

/**
 * Capture a screenshot from WDA and optionally downscale it using macOS `sips`.
 *
 * @param wda    - WDAClient instance
 * @param maxDim - Maximum dimension (width or height) in pixels. 0 = no scaling.
 */
export async function screenshot(
  wda: WDAClient,
  maxDim = 1000,
): Promise<ScreenshotResult> {
  const base64 = await wda.getScreenshot();
  const screen = await wda.getWindowSize();
  const pxW = screen.width * screen.scale;
  const pxH = screen.height * screen.scale;

  if (maxDim <= 0 || Math.max(pxW, pxH) <= maxDim) {
    return {
      base64,
      note: `${pxW}×${pxH}px (${screen.width}×${screen.height}pt @${screen.scale}x)`,
    };
  }

  const tmp = join(tmpdir(), `ios-bridge-shot-${Date.now()}.png`);
  try {
    await writeFile(tmp, Buffer.from(base64, "base64"));
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("sips", ["-Z", String(maxDim), tmp], {
        stdio: "ignore",
      });
      proc.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`sips exited with code ${code}`)),
      );
      proc.on("error", reject);
    });

    const scaled = await readFile(tmp);
    const ratio = maxDim / Math.max(pxW, pxH);
    return {
      base64: scaled.toString("base64"),
      note:
        `Downscaled to ~${Math.round(pxW * ratio)}×${Math.round(pxH * ratio)}px. ` +
        `Tap coordinates use POINTS (${screen.width}×${screen.height}), not image pixels.`,
    };
  } catch {
    // Fallback: return the original unscaled image
    return { base64, note: `${pxW}×${pxH}px (unscaled, sips unavailable)` };
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
