import { startTestServer, type TestServer } from "../helpers/miniflare-server";

let server: TestServer | null = null;

export async function setup(): Promise<void> {
  server = await startTestServer();
  process.env.TEST_SERVER_URL = server.url.toString();
}

export async function teardown(): Promise<void> {
  if (server) {
    await server.stop();
    server = null;
  }
}
