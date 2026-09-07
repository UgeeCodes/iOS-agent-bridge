import axios from "axios";

export class WDAClient {
  private baseUrl: string;
  private sessionId: string | null = null;

  constructor(baseUrl?: string) {
    this.baseUrl =
      baseUrl ?? process.env.WDA_BASE_URL ?? "http://127.0.0.1:8100";
  }

  /** Ensure a WDA session exists, creating one if needed. */
  private async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;

    const response = await axios.post(`${this.baseUrl}/session`, {
      capabilities: {},
    });

    const id = response.data?.value?.sessionId ?? response.data?.sessionId;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("Failed to create WDA session — no sessionId returned.");
    }

    this.sessionId = id;
    return id;
  }

  async getStatus() {
    const response = await axios.get(`${this.baseUrl}/status`);
    return response.data;
  }

  async getTree() {
    const sessionId = await this.ensureSession();
    const response = await axios.get(
      `${this.baseUrl}/session/${sessionId}/source`,
      { params: { format: "json" } },
    );
    return response.data;
  }

  async tap(x: number, y: number) {
    const sessionId = await this.ensureSession();
    const response = await axios.post(
      `${this.baseUrl}/session/${sessionId}/actions`,
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
  }

  async type(text: string) {
    const sessionId = await this.ensureSession();
    const response = await axios.post(
      `${this.baseUrl}/session/${sessionId}/wda/keys`,
      { value: [...text] },
    );
    return response.data;
  }
}
