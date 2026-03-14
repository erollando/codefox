import { loadEnvFile } from "./core/env.js";
import { runLocalCli } from "./core/local-cli.js";

try {
  await loadEnvFile();
  const exitCode = await runLocalCli(process.argv.slice(2), {
    log(line) {
      console.log(line);
    },
    error(line) {
      console.error(line);
    }
  });
  process.exitCode = exitCode;
} catch (error) {
  console.error(`Local CLI error: ${String(error)}`);
  process.exitCode = 1;
}
