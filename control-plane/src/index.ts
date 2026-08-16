import { runCli } from "./cli.js";

runCli().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Control-plane error: ${message}`);
  console.error("Make sure Docker is running and the minicloud-sample image is built.");
  process.exitCode = 1;
});
