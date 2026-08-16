import { DockerControl } from "./docker/control.js";

type Command = "start" | "deploy" | "stop" | "restart" | "status" | "logs";
const control = new DockerControl();

function parseTail(args: string[]): number {
  const index = args.indexOf("--tail");
  if (index < 0) return 100;
  const tail = Number(args[index + 1]);
  if (!Number.isInteger(tail) || tail < 0) throw new Error("--tail must be followed by a non-negative integer");
  return tail;
}

function printHelp(): void {
  console.log(`MiniCloud control plane

Usage: npm run control -- <command> [options]

Commands:
  start | deploy        Create (if needed) and start the container
  stop                  Gracefully stop the container
  restart               Restart a running container, or start a stopped one
  status                Show the container's current state
  logs [--tail N]       Show the most recent logs (default: 100 lines)
  logs --follow         Keep streaming new logs; press Ctrl+C to exit
`);
}

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  const [command, ...options] = args as [Command | undefined, ...string[]];
  if (command === "start" || command === "deploy") console.log((await control.deploy()).message);
  else if (command === "stop") console.log((await control.stop()).message);
  else if (command === "restart") console.log((await control.restart()).message);
  else if (command === "status") console.log(JSON.stringify(await control.status(), null, 2));
  else if (command === "logs") {
    const tail = parseTail(options);
    if (options.includes("--follow") || options.includes("-f")) await control.followLogs(tail);
    else process.stdout.write(await control.logs(tail));
  } else {
    printHelp();
    if (command) process.exitCode = 1;
  }
}
