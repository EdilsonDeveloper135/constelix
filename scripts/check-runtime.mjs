const minimumNodeMajor = 24;
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);

if (nodeMajor < minimumNodeMajor) {
  process.stderr.write(
    `Constelix requires Node.js ${minimumNodeMajor} or newer before installing dependencies. ` +
      `Current runtime: ${process.versions.node}. Switch Node versions, remove node_modules, and run pnpm install --frozen-lockfile again.\n`,
  );
  process.exitCode = 1;
}
