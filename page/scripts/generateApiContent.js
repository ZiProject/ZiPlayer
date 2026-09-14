const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const pageDir = path.resolve(__dirname, "..");
const repoDir = path.resolve(pageDir, "..");
const outputDir = path.join(pageDir, ".generated");
const reflectionPath = path.join(outputDir, "typedoc.json");
const outputPath = path.join(outputDir, "GeneratedApiContent.ts");

function text(value) {
	if (!value) return "";
	if (typeof value === "string") return value.trim();
	if (Array.isArray(value)) return value.map(text).filter(Boolean).join("\n").trim();
	if (typeof value === "object") {
		if (typeof value.text === "string") return value.text.trim();
		return Object.values(value).map(text).filter(Boolean).join("\n").trim();
	}
	return String(value).trim();
}

function commentText(comment) { return text(comment?.summary); }

function typeString(type) {
	if (!type) return "";
	if (typeof type === "string") return type;
	if (type.type === "intrinsic") return type.name;
	if (type.type === "reference") return type.name || type.qualifiedName || "unknown";
	if (type.type === "array") return `${typeString(type.elementType)}[]`;
	if (type.type === "union") return (type.types || []).map(typeString).join(" | ");
	if (type.type === "intersection") return (type.types || []).map(typeString).join(" & ");
	if (type.type === "literal") return typeof type.value === "string" ? JSON.stringify(type.value) : String(type.value);
	if (type.type === "reflection") {
		const declaration = type.declaration;
		if (declaration?.signatures?.length) return signatureString(declaration.signatures[0]);
		if (declaration?.children?.length) return `{ ${declaration.children.map((child) => `${child.name}: ${typeString(child.type)}`).join("; ")} }`;
	}
	return type.name || "unknown";
}

function parameterString(parameter) {
	return `${parameter.name}${parameter.flags?.isOptional ? "?" : ""}: ${typeString(parameter.type) || "unknown"}`;
}

function signatureString(signature) {
	const asyncPrefix = signature.flags?.isAsync ? "async " : "";
	return `${asyncPrefix}${signature.name || ""}(${(signature.parameters || []).map(parameterString).join(", ")}): ${typeString(signature.type) || "void"}`;
}

function returnInfo(signature) {
	if (!signature) return null;
	return { type: typeString(signature.type) || "void", description: commentText(signature.comment) };
}

function exampleFromComment(comment) {
	const tag = (comment?.blockTags || []).find((entry) => entry.tag === "@example");
	return text(tag?.content);
}

function kindOf(reflection) { return reflection.kindString || reflection.kind || "symbol"; }

function scopeOf(reflection) {
	const file = text(reflection.sources?.[0]?.fileName || reflection.sources?.[0]?.file) || "";
	if (file.includes("/plugins/") || file.includes("\\plugins\\")) return "plugins";
	if (file.includes("/extension/") || file.includes("\\extension\\")) return "extensions";
	return "core";
}

function keyOf(name) {
	return String(name || "symbol")
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/[^a-zA-Z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase();
}

function methodsOf(reflection) {
	const methods = [];
	for (const child of reflection.children || []) {
		for (const signature of child.signatures || []) {
			methods.push({
				name: child.name,
				signature: signatureString(signature),
				description: commentText(signature.comment) || commentText(child.comment),
				example: exampleFromComment(signature.comment) || exampleFromComment(child.comment),
				code: "",
				parameters: (signature.parameters || []).map((parameter) => ({
					name: parameter.name + (parameter.flags?.isOptional ? "?" : ""),
					type: typeString(parameter.type) || "unknown",
					description: commentText(parameter.comment),
					optional: Boolean(parameter.flags?.isOptional),
					default: "",
					variation: "",
				})),
				returns: returnInfo(signature),
			});
		}
	}
	return methods;
}

function propertiesOf(reflection) {
	return (reflection.children || [])
		.filter((child) => child.kindString === "Property" || child.kindString === "Accessor")
		.map((property) => ({
			name: property.name,
			type: typeString(property.type) || "unknown",
			description: commentText(property.comment),
			optional: Boolean(property.flags?.isOptional),
			default: "",
		}));
}

function collectReflections(node, result = [], seen = new Set()) {
	for (const child of node?.children || []) {
		if (seen.has(child.id)) continue;
		seen.add(child.id);
		const kind = kindOf(child);
		if (["Class", "Interface", "Type alias", "Function", "Enumeration", "Variable"].includes(kind)) result.push(child);
		collectReflections(child, result, seen);
	}
	return result;
}

function renderApiContent(reflection) {
	const symbols = collectReflections(reflection);
	const apiContent = {};
	const usedKeys = new Set();
	for (const symbol of symbols) {
		const key = keyOf(symbol.name);
		if (!key || usedKeys.has(key)) continue;
		usedKeys.add(key);
		apiContent[key] = toApiEntry(symbol);
	}
	return `// Auto-generated from TypeDoc. Do not edit manually.\n// Source of truth: core/src, extension/src and plugins/src.\n\nexport const generatedApiContent = ${JSON.stringify(apiContent, null, 2)} as const;\n`;
}

function toApiEntry(reflection) {
	const scope = scopeOf(reflection);
	const kind = kindOf(reflection).toLowerCase().replace("type alias", "type");
	const description = commentText(reflection.comment) || `${reflection.name} API`;
	const signature = reflection.signatures?.[0];
	return {
		title: reflection.name,
		description,
		summary: description.split(/\n\n|\n/)[0] || "",
		badges: [kind, scope, keyOf(reflection.name)],
		code: exampleFromComment(reflection.comment) || (signature ? signatureString(signature) : `// ${reflection.name}`),
		methods: methodsOf(reflection),
		events: [],
		properties: propertiesOf(reflection),
		params: signature?.parameters?.map((parameter) => ({
			name: parameter.name + (parameter.flags?.isOptional ? "?" : ""),
			type: typeString(parameter.type) || "unknown",
			description: commentText(parameter.comment),
			optional: Boolean(parameter.flags?.isOptional),
			default: "",
			variation: "",
		})) || [],
		returns: returnInfo(signature),
	};
}

function generate() {
	fs.mkdirSync(outputDir, { recursive: true });
	console.log("📚 Generating API reflection with TypeDoc...");
	execFileSync(path.join(pageDir, "node_modules", ".bin", "typedoc"), ["--options", path.join(pageDir, "typedoc.json")], {
		cwd: pageDir,
		stdio: "inherit",
	});
	if (!fs.existsSync(reflectionPath)) throw new Error(`TypeDoc did not create ${reflectionPath}`);
	const reflection = JSON.parse(fs.readFileSync(reflectionPath, "utf8"));
	fs.writeFileSync(outputPath, renderApiContent(reflection), "utf8");
	console.log(`✅ Generated API documentation -> ${path.relative(repoDir, outputPath)}`);
}

function check() {
	const before = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
	generate();
	const after = fs.readFileSync(outputPath, "utf8");
	if (before !== after) {
		console.error("❌ API documentation is stale or missing. Run npm run docs:generate.");
		process.exitCode = 1;
		return;
	}
	console.log("✅ API documentation is up to date.");
}

if (process.argv.includes("--check")) check();
else generate();
