import { createApp } from "./app.js";
import { loadEnvFile } from "./core/env.js";

const configPath = process.argv[2];

try {
  await loadEnvFile();
  const app = await createApp(configPath);
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`Received ${signal}, stopping CodeFox...`);
    void app
      .stop()
      .catch((error) => {
        console.error(`Shutdown error: ${String(error)}`);
      })
      .finally(() => {
        process.exit(0);
      });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await app.start();
} catch (error) {
  console.error(`Fatal error: ${String(error)}`);
  process.exitCode = 1;
}
