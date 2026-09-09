import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerToolHandlers } from "./tools/index.js";
import { WDAClient } from "./wda/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const server = new Server(
  { name: "ios-agent-bridge", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

registerToolHandlers(server, new WDAClient());

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
