import axios from "axios";

export class WDAClient {
  private baseUrl: string;

  constructor(baseUrl = "http://127.0.0.1:8100") {
    this.baseUrl = baseUrl;
  }

  async getStatus() {
    const response = await axios.get(`${this.baseUrl}/status`);
    return response.data;
  }

  async getTree() {
    const res = await axios.get(`${this.baseUrl}/source`);
    return res.data;
  }

  async tap(x: number, y: number) {
    return axios.post(`${this.baseUrl}/wda/tap/nil`, { x, y });
  }
}
