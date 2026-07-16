import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const FILE_COUNT = 10_000;
export const LINES_PER_BENCHMARK_FILE = 200;
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
      const statements = [
        ...(previous ? [`import { value as previous } from "./${previous}";`] : []),
        `export const value = ${previous ? "previous + 1" : "0"};`,
        `export function read${index}() { return value; }`,
      ];
      const filler = Array.from(
        { length: LINES_PER_BENCHMARK_FILE - statements.length },
        (_, line) => `// benchmark fixture line ${line + statements.length + 1}`,
      );
      const source = `${[...statements, ...filler].join("\n")}\n`;
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
