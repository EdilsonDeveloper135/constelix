import { chmod, cp, mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const webDist = resolve(root, "apps/web/dist");
const agentDist = resolve(root, "apps/agent/dist");
const packagedWebDist = resolve(agentDist, "web");

await stat(resolve(webDist, "index.html")).catch(() => {
  throw new Error("Build apps/web before packaging the Constelix CLI.");
});
await stat(resolve(agentDist, "cli.js")).catch(() => {
  throw new Error("Build apps/agent before packaging the Constelix CLI.");
});

await rm(packagedWebDist, { recursive: true, force: true });
await mkdir(agentDist, { recursive: true });
await cp(webDist, packagedWebDist, { recursive: true });
await chmod(resolve(agentDist, "cli.js"), 0o755);

process.stdout.write(`Packaged dashboard assets in ${packagedWebDist}\n`);
