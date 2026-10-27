const { readdirSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).filter((item) => !["node_modules", ".git", ".test-tmp", "uploads"].includes(item.name)).flatMap((item) => item.isDirectory() ? walk(path.join(dir, item.name)) : item.name.endsWith(".js") ? [path.join(dir, item.name)] : []);
}
const files = walk(root);
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax checked ${files.length} JavaScript files`);
