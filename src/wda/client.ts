import axios from "axios";
import { execSync } from "child_process";

function detectCoreDeviceIp(): string | null {
  try {
    const out = execSync("lsof -i -P -n 2>/dev/null | grep -i Xcode", {
      encoding: "utf8",
    });
    const match = out.match(/->\[([0-9a-fA-F:]+)\]:\d+/);
    if (match) return match[1];
  } catch {}
  return null;
}

export class WDAClient {
  private baseUrl: string;
  private sessionId: string | null = null;

  constructor(baseUrl?: string) {
    if (baseUrl) {
      this.baseUrl = baseUrl;
    } else if (process.env.WDA_BASE_URL) {
      this.baseUrl = process.env.WDA_BASE_URL;
    } else {
      const autoIp = detectCoreDeviceIp();
      this.baseUrl = autoIp
        ? `http://[${autoIp}]:8100`
        : "http://127.0.0.1:8100";
    }
  }

  /** Refresh or resolve the base URL dynamically if the current address is unreachable */
  private async getActiveBaseUrl(): Promise<string> {
    try {
      await axios.get(`${this.baseUrl}/status`, { timeout: 2000 });
      return this.baseUrl;
    } catch {
      const detected = detectCoreDeviceIp();
      if (detected) {
        const candidate = `http://[${detected}]:8100`;
        try {
          await axios.get(`${candidate}/status`, { timeout: 2000 });
          this.baseUrl = candidate;
          this.sessionId = null; // Reset session for new connection
          return this.baseUrl;
        } catch {}
      }
      return this.baseUrl;
    }
  }

  /** Ensure a WDA session exists, creating one if needed. */
  private async ensureSession(): Promise<{
    baseUrl: string;
    sessionId: string;
  }> {
    const baseUrl = await this.getActiveBaseUrl();
    if (this.sessionId) return { baseUrl, sessionId: this.sessionId };

    const response = await axios.post(`${baseUrl}/session`, {
      capabilities: {},
    });

    const id = response.data?.value?.sessionId ?? response.data?.sessionId;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("Failed to create WDA session — no sessionId returned.");
    }

    this.sessionId = id;
    return { baseUrl, sessionId: id };
  }

  /** Run an operation with the active session, retrying once if session expired (404) */
  private async withSession<T>(
    fn: (baseUrl: string, sessionId: string) => Promise<T>,
  ): Promise<T> {
    const { baseUrl, sessionId } = await this.ensureSession();
    try {
      return await fn(baseUrl, sessionId);
    } catch (err: any) {
      if (err?.response?.status === 404) {
        this.sessionId = null;
        const fresh = await this.ensureSession();
        return await fn(fresh.baseUrl, fresh.sessionId);
      }
      throw err;
    }
  }

  async getStatus() {
    const baseUrl = await this.getActiveBaseUrl();
    const response = await axios.get(`${baseUrl}/status`);
    return response.data;
  }

  async getTree() {
    return this.withSession(async (baseUrl, sessionId) => {
      const response = await axios.get(
        `${baseUrl}/session/${sessionId}/source`,
        { params: { format: "json" } },
      );
      return response.data;
    });
  }

  async tap(x: number, y: number) {
    return this.withSession(async (baseUrl, sessionId) => {
      const response = await axios.post(
        `${baseUrl}/session/${sessionId}/actions`,
        {
          actions: [
            {
              type: "pointer",
              id: "finger1",
              parameters: { pointerType: "touch" },
              actions: [
                { type: "pointerMove", duration: 0, x, y },
                { type: "pointerDown", button: 0 },
                { type: "pause", duration: 100 },
                { type: "pointerUp", button: 0 },
              ],
            },
          ],
        },
      );
      return response.data;
    });
  }

  async swipe(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    durationMs = 300,
  ) {
    return this.withSession(async (baseUrl, sessionId) => {
      const response = await axios.post(
        `${baseUrl}/session/${sessionId}/actions`,
        {
          actions: [
            {
              type: "pointer",
              id: "finger1",
              parameters: { pointerType: "touch" },
              actions: [
                {
                  type: "pointerMove",
                  duration: 0,
                  x: Math.round(startX),
                  y: Math.round(startY),
                },
                { type: "pointerDown", button: 0 },
                { type: "pause", duration: 100 },
                {
                  type: "pointerMove",
                  duration: durationMs,
                  x: Math.round(endX),
                  y: Math.round(endY),
                },
                { type: "pointerUp", button: 0 },
              ],
            },
          ],
        },
      );
      return response.data;
    });
  }

  async type(text: string) {
    return this.withSession(async (baseUrl, sessionId) => {
      const response = await axios.post(
        `${baseUrl}/session/${sessionId}/wda/keys`,
        { value: [...text] },
      );
      return response.data;
    });
  }

  async getScreenshot(): Promise<string> {
    const baseUrl = await this.getActiveBaseUrl();
    const response = await axios.get(`${baseUrl}/screenshot`, {
      timeout: 30_000,
    });
    return response.data?.value ?? response.data;
  }

  async getWindowSize(): Promise<{
    width: number;
    height: number;
    scale: number;
  }> {
    return this.withSession(async (baseUrl, sessionId) => {
      const response = await axios.get(
        `${baseUrl}/session/${sessionId}/window/size`,
      );
      const { width, height } = response.data?.value ?? response.data;
      // WDA doesn't return scale directly; default to 3x for modern iPhones
      return { width, height, scale: 3 };
    });
  }

  resetSession(): void {
    this.sessionId = null;
  }

  async isLocked(): Promise<boolean> {
    const baseUrl = await this.getActiveBaseUrl();
    const response = await axios.get(`${baseUrl}/wda/locked`);
    return Boolean(response.data?.value);
  }

  async unlock(): Promise<void> {
    const baseUrl = await this.getActiveBaseUrl();
    await axios.post(`${baseUrl}/wda/unlock`);
  }

  async lock(): Promise<void> {
    const baseUrl = await this.getActiveBaseUrl();
    await axios.post(`${baseUrl}/wda/lock`);
  }

  async getActiveApp(): Promise<{ bundleId: string; pid: number }> {
    const baseUrl = await this.getActiveBaseUrl();
    const response = await axios.get(`${baseUrl}/wda/activeAppInfo`);
    const val = response.data?.value ?? response.data;
    return {
      bundleId: val?.bundleId ?? "",
      pid: val?.pid ?? 0,
    };
  }
}
