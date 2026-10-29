const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..", "..");
const source = path.join(projectRoot, "docs", "architecture", "ziplayer-architecture.html");
const destination = path.join(__dirname, "..", "public", "architecture", "ziplayer-architecture.html");

if (!fs.existsSync(source)) {
	throw new Error(`Missing architecture source: ${path.relative(projectRoot, source)}`);
}

fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.copyFileSync(source, destination);
console.log(`Synced architecture diagram to ${path.relative(projectRoot, destination)}`);
