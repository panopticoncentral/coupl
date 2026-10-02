import { build } from "esbuild";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
const client = await build({ entryPoints: ["src/extension.ts"], outfile: "dist/extension.cjs", bundle: true, platform: "node", format: "cjs", target: "node22", external: ["vscode"], sourcemap: true, metafile: true });
const server = await build({ entryPoints: ["../language-server/src/server.ts"], outfile: "dist/server.cjs", bundle: true, platform: "node", format: "cjs", target: "node22", sourcemap: true, metafile: true });

// Keep the licenses of bundled dependencies with the self-contained VSIX.
const notices = new Map();
for (const input of new Set([...Object.keys(client.metafile.inputs), ...Object.keys(server.metafile.inputs)])) {
  if (!input.includes("node_modules/")) continue;
  let directory = dirname(resolve(input));
  while (directory !== dirname(directory)) {
    let manifest;
    try { manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")); } catch {}
    if (manifest?.name) {
      const key = `${manifest.name}@${manifest.version}`;
      if (!notices.has(key)) {
        const license = (await readdir(directory)).find(name => /^licen[cs]e(?:\..*)?$/i.test(name));
        if (!license) throw new Error(`Missing bundled license for ${key}`);
        notices.set(key, await readFile(join(directory, license), "utf8"));
      }
      break;
    }
    directory = dirname(directory);
  }
}
await writeFile("dist/ThirdPartyNotices.txt", [...notices].sort(([a], [b]) => a.localeCompare(b)).map(([name, license]) => `${name}\n${"=".repeat(name.length)}\n${license}`).join("\n\n"));
