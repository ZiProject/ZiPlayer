const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const pageDir = path.resolve(__dirname, "..");
const repoDir = path.resolve(pageDir, "..");
const outputDir = path.join(pageDir, ".generated");
const reflectionPath = path.join(outputDir, "typedoc.json");
const outputPath = path.join(outputDir, "GeneratedApiContent.ts");

const EXPORT_ROOTS = [
	{ name: "core", entry: path.join(repoDir, "core", "src", "index.ts") },
	{ name: "plugins", entry: path.join(repoDir, "plugins", "src", "index.ts") },
	{ name: "extensions", entry: path.join(repoDir, "extension", "src", "index.ts") },
];

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
	if (type.type === "tuple") return `[${(type.elements || []).map(typeString).join(", ")}]`;
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

function sourceFileOf(reflection) {
	return text(reflection.sources?.[0]?.fileName || reflection.sources?.[0]?.file) || "";
}

function normalizeFile(file) {
	return path.normalize(file).replace(/\\/g, "/");
}

function scopeOf(reflection) {
	const file = sourceFileOf(reflection);
	if (file.includes("/plugins/")) return "plugins";
	if (file.includes("/extension/")) return "extensions";
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

function eventsOf(reflection) {
	if (!reflection || !/events?$/i.test(reflection.name || "")) return [];
	return (reflection.children || [])
		.filter((child) => child.kindString === "Property")
		.map((event) => {
			const type = event.type;
			const parameters = type?.type === "tuple"
				? (type.elements || []).map((element) => typeString(element) || "unknown")
				: [];
			return {
				name: event.name,
				description: commentText(event.comment),
				parameters,
			};
		});
}

function isPublicReflection(reflection) {
	if (!reflection) return false;
	if (reflection.flags?.isPrivate || reflection.flags?.isProtected || reflection.flags?.isInternal) return false;
	return reflection.flags?.isExported !== false;
}

function collectReflections(node, result = [], seen = new Set()) {
	for (const child of node?.children || []) {
		if (seen.has(child.id)) continue;
		seen.add(child.id);
		if (!isPublicReflection(child)) continue;
		const kind = kindOf(child);
		if (["Class", "Interface", "Type alias", "Function", "Enumeration", "Variable"].includes(kind)) result.push(child);
		collectReflections(child, result, seen);
	}
	return result;
}

function stripComments(source) {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|\s)\/\/.*$/gm, "$1");
}

function resolveModule(fromFile, specifier) {
	if (!specifier.startsWith(".")) return null;
	const base = path.resolve(path.dirname(fromFile), specifier);
	const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.d.ts`, path.join(base, "index.ts"), path.join(base, "index.tsx")];
	return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function parseExportEdges(file) {
	const source = stripComments(fs.readFileSync(file, "utf8"));
	const edges = [];

	for (const match of source.matchAll(/export\s+(?:type\s+)?\*\s+from\s+["']([^"']+)["']\s*;?/g)) {
		const target = resolveModule(file, match[1]);
		if (target) edges.push({ target, names: null });
	}

	for (const match of source.matchAll(/export\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+["']([^"']+)["']\s*;?/g)) {
		const target = resolveModule(file, match[2]);
		if (!target) continue;
		const names = match[1]
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean)
			.map((item) => {
				const parts = item.split(/\s+as\s+/i).map((part) => part.trim());
				return { exported: parts[1] || parts[0], imported: parts[0] };
			});
		edges.push({ target, names });
	}

	return edges;
}

function collectExportNames(file, cache = new Map(), stack = new Set()) {
	const normalized = normalizeFile(file);
	if (cache.has(normalized)) return cache.get(normalized);
	if (stack.has(normalized)) return new Map();
	stack.add(normalized);

	const names = new Map();
	const source = stripComments(fs.readFileSync(file, "utf8"));

	for (const match of source.matchAll(/export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|interface|enum|namespace|function|const|let|var|type)\s+([A-Za-z_$][\w$]*)/g)) {
		names.set(match[1], normalized);
	}

	for (const edge of parseExportEdges(file)) {
		const childNames = collectExportNames(edge.target, cache, new Set(stack));
		if (edge.names === null) {
			for (const [name, sourceFile] of childNames) if (name !== "default") names.set(name, sourceFile);
		} else {
			for (const item of edge.names) {
				const sourceFile = childNames.get(item.imported);
				if (sourceFile) names.set(item.exported, sourceFile);
			}
		}
	}

	cache.set(normalized, names);
	return names;
}

function buildPublicExportGraph() {
	const graph = new Map();
	const cache = new Map();
	for (const root of EXPORT_ROOTS) {
		if (!fs.existsSync(root.entry)) throw new Error(`Public export root does not exist: ${root.entry}`);
		const exports = collectExportNames(root.entry, cache);
		for (const [name, sourceFile] of exports) {
			if (!graph.has(sourceFile)) graph.set(sourceFile, new Map());
			graph.get(sourceFile).set(name, [...(graph.get(sourceFile).get(name) || []), root.name]);
		}
	}
	return graph;
}

function publicFromOf(reflection, exportGraph) {
	const sourceFile = normalizeFile(path.resolve(repoDir, sourceFileOf(reflection)));
	const sourceExports = exportGraph.get(sourceFile);
	const direct = sourceExports?.get(reflection.name) || [];
	if (direct.length) return [...new Set(direct)];

	// TypeDoc may report a source path relative to the package rather than repo root.
	const suffix = normalizeFile(sourceFileOf(reflection));
	for (const [file, names] of exportGraph) {
		if (!file.endsWith(suffix)) continue;
		const roots = names.get(reflection.name);
		if (roots?.length) return [...new Set(roots)];
	}
	return [];
}

function renderApiContent(reflection) {
	const exportGraph = buildPublicExportGraph();
	const symbols = collectReflections(reflection);
	const apiContent = {};
	const usedKeys = new Set();

	for (const symbol of symbols) {
		const publicFrom = publicFromOf(symbol, exportGraph);
		if (!publicFrom.length) continue;

		// One API entry per symbol. Root ordering is intentional: core is the primary
		// package surface when a symbol is re-exported by multiple packages.
		const scope = publicFrom[0];
		const baseKey = keyOf(symbol.name);
		if (!baseKey) continue;
		const key = `${scope}-${baseKey}`;
		if (usedKeys.has(key)) continue;
		usedKeys.add(key);
		apiContent[key] = toApiEntry(symbol, scope, publicFrom);
	}

	return `// Auto-generated from TypeDoc + traced public export roots. Do not edit manually.\n// Source of truth: core/src/index.ts, extension/src/index.ts and plugins/src/index.ts.\n\nexport const generatedApiContent = ${JSON.stringify(apiContent, null, 2)} as const;\n`;
}

function toApiEntry(reflection, scope, publicFrom) {
	const kind = kindOf(reflection).toLowerCase().replace("type alias", "type");
	const description = commentText(reflection.comment) || `${reflection.name} API`;
	const signature = reflection.signatures?.[0];
	return {
		title: reflection.name,
		description,
		summary: description.split(/\n\n|\n/)[0] || "",
		badges: [kind, scope, keyOf(reflection.name)],
		publicFrom,
		code: exampleFromComment(reflection.comment) || (signature ? signatureString(signature) : `// ${reflection.name}`),
		methods: methodsOf(reflection),
		events: eventsOf(reflection),
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
	const typedocBin = process.platform === "win32"
		? path.join(pageDir, "node_modules", ".bin", "typedoc.cmd")
		: path.join(pageDir, "node_modules", ".bin", "typedoc");
	execFileSync(typedocBin, ["--options", path.join(pageDir, "typedoc.json")], {
		cwd: pageDir,
		stdio: "inherit",
	});
	if (!fs.existsSync(reflectionPath)) throw new Error(`TypeDoc did not create ${reflectionPath}`);
	const reflection = JSON.parse(fs.readFileSync(reflectionPath, "utf8"));
	fs.writeFileSync(outputPath, renderApiContent(reflection), "utf8");
	console.log(`✅ Generated API documentation -> ${path.relative(repoDir, outputPath)}`);
}

if (process.argv.includes("--check")) {
	console.error("Use npm run docs:check for a clean TypeDoc validation; generated API output is intentionally untracked.");
	process.exitCode = 1;
} else {
	generate();
}
