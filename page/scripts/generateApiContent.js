const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ts = require('typescript');

const pageDir = path.resolve(__dirname, '..');
const repoDir = path.resolve(pageDir, '..');
const outputDir = path.join(pageDir, '.generated');
const reflectionPath = path.join(outputDir, 'typedoc.json');
const outputPath = path.join(outputDir, 'GeneratedApiContent.ts');

const EXPORT_ROOTS = [
  { name: 'core', entry: path.join(repoDir, 'core', 'src', 'index.ts') },
  { name: 'plugins', entry: path.join(repoDir, 'plugins', 'src', 'index.ts') },
  { name: 'extensions', entry: path.join(repoDir, 'extension', 'src', 'index.ts') },
];

function text(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('\n').trim();
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.trim();
    return Object.values(value).map(text).filter(Boolean).join('\n').trim();
  }
  return String(value).trim();
}

function commentText(comment) { return text(comment?.summary); }

function typeString(type) {
  if (!type) return '';
  if (typeof type === 'string') return type;
  if (type.type === 'intrinsic') return type.name;
  if (type.type === 'reference') return type.name || type.qualifiedName || 'unknown';
  if (type.type === 'array') return `${typeString(type.elementType)}[]`;
  if (type.type === 'union') return (type.types || []).map(typeString).join(' | ');
  if (type.type === 'intersection') return (type.types || []).map(typeString).join(' & ');
  if (type.type === 'tuple') return `[${(type.elements || []).map(typeString).join(', ')}]`;
  if (type.type === 'literal') return typeof type.value === 'string' ? JSON.stringify(type.value) : String(type.value);
  if (type.type === 'reflection') {
    const declaration = type.declaration;
    if (declaration?.signatures?.length) return signatureString(declaration.signatures[0]);
    if (declaration?.children?.length) return `{ ${declaration.children.map((child) => `${child.name}: ${typeString(child.type)}`).join('; ')} }`;
  }
  return type.name || 'unknown';
}

function parameterString(parameter) {
  return `${parameter.name}${parameter.flags?.isOptional ? '?' : ''}: ${typeString(parameter.type) || 'unknown'}`;
}

function signatureString(signature) {
  const asyncPrefix = signature.flags?.isAsync ? 'async ' : '';
  return `${asyncPrefix}${signature.name || ''}(${(signature.parameters || []).map(parameterString).join(', ')}): ${typeString(signature.type) || 'void'}`;
}

function returnInfo(signature) {
  if (!signature) return null;
  return { type: typeString(signature.type) || 'void', description: commentText(signature.comment) };
}

function exampleFromComment(comment) {
  const tag = (comment?.blockTags || []).find((entry) => entry.tag === '@example');
  return text(tag?.content);
}

function kindOf(reflection) { return reflection.kindString || reflection.kind || 'symbol'; }

function sourceFileOf(reflection) {
  return text(reflection.sources?.[0]?.fileName || reflection.sources?.[0]?.file) || '';
}

function normalizeFile(file) {
  return path.normalize(file).replace(/\\/g, '/');
}

function keyOf(name) {
  return String(name || 'symbol')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
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
        code: '',
        parameters: (signature.parameters || []).map((parameter) => ({
          name: parameter.name + (parameter.flags?.isOptional ? '?' : ''),
          type: typeString(parameter.type) || 'unknown',
          description: commentText(parameter.comment),
          optional: Boolean(parameter.flags?.isOptional),
          default: '',
          variation: '',
        })),
        returns: returnInfo(signature),
      });
    }
  }
  return methods;
}

function propertiesOf(reflection) {
  return (reflection.children || [])
    .filter((child) => child.kindString === 'Property' || child.kindString === 'Accessor')
    .map((property) => ({
      name: property.name,
      type: typeString(property.type) || 'unknown',
      description: commentText(property.comment),
      optional: Boolean(property.flags?.isOptional),
      default: '',
    }));
}

function eventsOf(reflection) {
  if (!reflection || !/events?$/i.test(reflection.name || '')) return [];
  return (reflection.children || [])
    .filter((child) => child.kindString === 'Property')
    .map((event) => {
      const type = event.type;
      const parameters = type?.type === 'tuple'
        ? (type.elements || []).map((element) => typeString(element) || 'unknown')
        : [];
      return { name: event.name, description: commentText(event.comment), parameters };
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
    const kind = kindOf(child);
    if (isPublicReflection(child) && ['Class', 'Interface', 'Type alias', 'Function', 'Enumeration', 'Variable'].includes(kind)) {
      result.push(child);
    }
    collectReflections(child, result, seen);
  }
  return result;
}

function sourceFilesOfSymbol(symbol, checker) {
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const declarations = resolved.declarations || symbol.declarations || [];
  return [...new Set(declarations
    .map((declaration) => declaration.getSourceFile()?.fileName)
    .filter(Boolean)
    .map((file) => normalizeFile(path.resolve(file))))];
}

function createExportProgram() {
  // Use one program containing every source file behind all public roots.
  // A single core tsconfig cannot correctly resolve the plugins/extensions
  // projects, whose module/moduleResolution settings and imports differ.
  const sourceFiles = [];
  for (const directory of ['core/src', 'plugins/src', 'extension/src']) {
    const absoluteDirectory = path.join(repoDir, directory);
    if (fs.existsSync(absoluteDirectory)) {
      sourceFiles.push(...ts.sys.readDirectory(absoluteDirectory, ['.ts', '.tsx'], undefined, undefined, undefined));
    }
  }

  const rootNames = [...new Set([...sourceFiles, ...EXPORT_ROOTS.map((root) => root.entry)])];
  return ts.createProgram(rootNames, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    strict: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    noEmit: true,
  });
}

function buildPublicExportGraph() {
  const program = createExportProgram();
  const checker = program.getTypeChecker();
  const graph = new Map();
  const rootStats = [];

  for (const root of EXPORT_ROOTS) {
    const rootFile = path.resolve(root.entry);
    const sourceFile = program.getSourceFile(rootFile) || program.getSourceFile(root.entry);
    if (!sourceFile) throw new Error(`Public export root is not in TypeScript program: ${root.entry}`);
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) throw new Error(`Cannot resolve module symbol for public export root: ${root.entry}`);

    const exports = checker.getExportsOfModule(moduleSymbol);
    let resolvedCount = 0;
    for (const exported of exports) {
      const sourceFiles = sourceFilesOfSymbol(exported, checker);
      if (!sourceFiles.length) continue;
      resolvedCount++;
      for (const sourceFileName of sourceFiles) {
        if (!graph.has(sourceFileName)) graph.set(sourceFileName, new Map());
        const names = graph.get(sourceFileName);
        const roots = names.get(exported.name) || [];
        if (!roots.includes(root.name)) roots.push(root.name);
        names.set(exported.name, roots);
      }
    }
    rootStats.push(`${root.name}:${exports.length}/${resolvedCount}`);
  }

  if (!graph.size) {
    throw new Error(`TypeScript public export graph is empty (${rootStats.join(', ')}).`);
  }

  return graph;
}

function publicFromOf(reflection, exportGraph) {
  const name = reflection.name;
  const source = normalizeFile(sourceFileOf(reflection));

  const candidates = new Set();
  if (source) {
    candidates.add(source);
    candidates.add(normalizeFile(path.resolve(repoDir, source)));
    candidates.add(normalizeFile(path.resolve(pageDir, source)));
  }

  for (const [file, names] of exportGraph) {
    const normalizedFile = normalizeFile(file);
    const fileMatch = [...candidates].some((candidate) =>
      normalizedFile === candidate ||
      normalizedFile.endsWith(`/${candidate}`) ||
      candidate.endsWith(`/${normalizedFile}`),
    );
    if (!fileMatch) continue;
    const roots = names.get(name);
    if (roots?.length) return [...new Set(roots)];
  }

  const matches = [];
  for (const [file, names] of exportGraph) {
    const roots = names.get(name);
    if (roots?.length) matches.push({ file, roots });
  }
  if (matches.length === 1) return [...new Set(matches[0].roots]);

  return [];
}

function renderApiContent(reflection) {
  const exportGraph = buildPublicExportGraph();
  const symbols = collectReflections(reflection);
  const apiContent = {};
  const usedKeys = new Set();
  let publicCount = 0;

  for (const symbol of symbols) {
    const publicFrom = publicFromOf(symbol, exportGraph);
    if (!publicFrom.length) continue;
    publicCount++;

    const scope = publicFrom[0];
    const baseKey = keyOf(symbol.name);
    if (!baseKey) continue;
    const key = `${scope}-${baseKey}`;
    if (usedKeys.has(key)) continue;
    usedKeys.add(key);
    apiContent[key] = toApiEntry(symbol, scope, publicFrom);
  }

  if (!publicCount || !Object.keys(apiContent).length) {
    throw new Error(
      `API export tracing produced no public symbols. ` +
      `TypeDoc reflections: ${symbols.length}; export graph files: ${exportGraph.size}. ` +
      `Check TypeDoc source paths and public roots: ${EXPORT_ROOTS.map((root) => root.entry).join(', ')}`,
    );
  }

  return `// Auto-generated from TypeDoc + TypeScript compiler public export graph. Do not edit manually.\n// Source of truth: core/src/index.ts, extension/src/index.ts and plugins/src/index.ts.\n\nexport const generatedApiContent = ${JSON.stringify(apiContent, null, 2)} as const;\n`;
}

function toApiEntry(reflection, scope, publicFrom) {
  const kind = kindOf(reflection).toLowerCase().replace('type alias', 'type');
  const description = commentText(reflection.comment) || `${reflection.name} API`;
  const signature = reflection.signatures?.[0];
  return {
    title: reflection.name,
    description,
    summary: description.split(/\n\n|\n/)[0] || '',
    badges: [kind, scope, keyOf(reflection.name)],
    publicFrom,
    code: exampleFromComment(reflection.comment) || (signature ? signatureString(signature) : `// ${reflection.name}`),
    methods: methodsOf(reflection),
    events: eventsOf(reflection),
    properties: propertiesOf(reflection),
    params: signature?.parameters?.map((parameter) => ({
      name: parameter.name + (parameter.flags?.isOptional ? '?' : ''),
      type: typeString(parameter.type) || 'unknown',
      description: commentText(parameter.comment),
      optional: Boolean(parameter.flags?.isOptional),
      default: '',
      variation: '',
    })) || [],
    returns: returnInfo(signature),
  };
}

function resolveTypeDocCli() {
  // TypeDoc 0.28+ does not export ./bin/typedoc.js through package exports.
  // package.json itself is exported, so resolve the package root first.
  const packageJson = require.resolve('typedoc/package.json');
  return path.join(path.dirname(packageJson), 'bin', 'typedoc');
}

function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  console.log('📚 Generating API reflection with TypeDoc...');
  const typedocCli = resolveTypeDocCli();
  execFileSync(process.execPath, [typedocCli, '--options', path.join(pageDir, 'typedoc.json')], {
    cwd: pageDir,
    stdio: 'inherit',
  });
  if (!fs.existsSync(reflectionPath)) throw new Error(`TypeDoc output not found: ${reflectionPath}`);
  const reflection = JSON.parse(fs.readFileSync(reflectionPath, 'utf8'));
  const generated = renderApiContent(reflection);
  fs.writeFileSync(outputPath, generated, 'utf8');
  console.log(`✅ Generated API documentation -> ${outputPath}`);
}

if (require.main === module) main();