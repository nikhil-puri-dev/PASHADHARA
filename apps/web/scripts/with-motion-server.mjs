// Run browser checks against an isolated production server on an OS-picked port.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const app = fileURLToPath(new URL("../", import.meta.url));
const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
const [script, ...args] = process.argv.slice(2);
if (!script) throw new Error("Pass the path of the browser check or --check-cord.");
const server = spawn(process.execPath, [next, "start", "--hostname", "127.0.0.1", "--port", "0"], {
  cwd: app, stdio: ["ignore", "pipe", "inherit"], windowsHide: true,
});
const addr = new Promise((resolve, reject) => {
  let output = "";
  server.stdout.on("data", chunk => {
    process.stdout.write(chunk);
    output += chunk;
    const url = output.match(/http:\/\/(?:localhost|127\.0\.0\.1):[1-9]\d+/)?.[0];
    if (url && output.includes("Ready")) resolve(url);
  });
  server.once("error", reject);
  server.once("exit", code => reject(new Error(`Next exited with code ${code}`)));
});
const timeout = setTimeout(() => server.kill(), 30_000);
try {
  const url = await addr;
  clearTimeout(timeout);
  let command = process.execPath;
  let checkArgs = [script, ...args];
  if (script === "--check-cord") {
    command = "pnpm";
    checkArgs = ["--filter", "@pashadhara/web", "check:cord"];
    if (process.platform === "win32") {
      command = process.env.ComSpec || "cmd.exe";
      checkArgs.unshift("/d", "/c", "pnpm");
    }
  }
  const check = spawn(command, checkArgs, {
    stdio: "inherit", windowsHide: true, env: { ...process.env, CORD_URL: url, MOTION_URL: url },
  });
  const [code] = await once(check, "exit");
  process.exitCode = code ?? 1;
} finally {
  clearTimeout(timeout);
  server.kill();
}
