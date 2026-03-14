import { loadEnvFile } from "./core/env.js";
import { runLocalCli } from "./core/local-cli.js";

try {
  await loadEnvFile();
  const exitCode = await runLocalCli(["handoff", ...process.argv.slice(2)], {
    log(line) {
      console.log(line);
    },
    error(line) {
      console.error(line);
    }
  });
  process.exitCode = exitCode;
} catch (error) {
  console.error(`Handoff CLI error: ${String(error)}`);
  process.exitCode = 1;
}
