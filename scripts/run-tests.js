const { readdirSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const mode = process.argv[2] || "all";
if (!["all", "unit", "integration"].includes(mode)) throw new Error("Choose all, unit or integration");
// The legacy camp script requires a manually selected disposable database and
// is deliberately excluded. Every automated integration creates its own replica.
const files = readdirSync(path.join(__dirname, "../tests")).filter((name) => name.endsWith(".test.js") && name !== "holidayCamp.test.js" && (mode === "all" || name.includes(".integration.") === (mode === "integration"))).sort().map((name) => path.join(__dirname, "../tests", name));
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], { stdio: "inherit", env: { ...process.env, NODE_ENV: "test" } });
process.exitCode = result.status ?? 1;
