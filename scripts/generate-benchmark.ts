import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const FILE_COUNT = 10_000;
const BATCH_SIZE = 250;

export async function generateBenchmarkFixture(fileCount = FILE_COUNT): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "constelix-benchmark-"));
  const sourceRoot = join(root, "src");
  await mkdir(sourceRoot, { recursive: true });

  for (let start = 0; start < fileCount; start += BATCH_SIZE) {
    const jobs: Promise<void>[] = [];
    const end = Math.min(start + BATCH_SIZE, fileCount);
    for (let index = start; index < end; index += 1) {
      const previous = index === 0 ? null : `module-${index - 1}.js`;
      const source = previous
        ? `import { value as previous } from "./${previous}";\nexport const value = previous + 1;\nexport function read${index}() { return value; }\n`
        : "export const value = 0;\nexport function read0() { return value; }\n";
      jobs.push(writeFile(join(sourceRoot, `module-${index}.js`), source, "utf8"));
    }
    await Promise.all(jobs);
  }

  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "constelix-benchmark", private: true, type: "module" }, null, 2),
    "utf8"
  );
  return root;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${await generateBenchmarkFixture()}\n`);
}
