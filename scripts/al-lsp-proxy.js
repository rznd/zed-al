// stdio proxy between Zed and the ALTool language server.
//
// ALTool's `launchlspserver` never publishes diagnostics, so this proxy compiles the AL project
// that owns a saved (or first opened) file with `al compile` and turns the error log into
// `textDocument/publishDiagnostics` notifications. It also rewrites VS Code-style completion
// labels that Zed cannot deserialize.
//
// usage: al-lsp-proxy.js [--no-diagnostics] [--no-compile-on-open] -- <al-command> [server-args...]
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");

const PROXY_REQUEST_ID_PREFIX = "al-lsp-proxy:";
const COMPILE_DEBOUNCE_MS = 300;
const TOOL_PACKAGE = "microsoft.dynamics.businesscentral.development.tools";
const ANALYZER_DLLS = {
  CodeCop: "Microsoft.Dynamics.Nav.CodeCop.dll",
  UICop: "Microsoft.Dynamics.Nav.UICop.dll",
  AppSourceCop: "Microsoft.Dynamics.Nav.AppSourceCop.dll",
  PerTenantExtensionCop: "Microsoft.Dynamics.Nav.PerTenantExtensionCop.dll",
};
const SEVERITIES = { error: 1, warning: 2, info: 3, information: 3, hint: 4 };

const { options, serverCommand, serverArgs } = parseArguments(process.argv);

if (!serverCommand) {
  console.error(
    "usage: al-lsp-proxy [--no-diagnostics] [--no-compile-on-open] -- <server-command> [server-args...]",
  );
  process.exit(2);
}

const completionRequestIds = new Set();
const initializeRequestIds = new Set();
let proxyRequestCounter = 0;
const child = spawn(serverCommand, serverArgs, {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
const analysis = createBackgroundAnalysis({
  alCommand: serverCommand,
  enabled: options.diagnostics,
  compileOnOpen: options.compileOnOpen,
});

process.on("uncaughtException", (error) => {
  logError(`uncaught proxy exception: ${formatError(error)}`);
  shutdown(1);
});

process.on("unhandledRejection", (error) => {
  logError(`unhandled proxy rejection: ${formatError(error)}`);
  shutdown(1);
});

child.stderr.pipe(process.stderr);

child.on("error", (error) => {
  logError(`failed to start AL language server proxy target: ${error.message}`);
  shutdown(1);
});

child.on("exit", (code, signal) => {
  const exitCode = code ?? (signal ? 1 : 0);

  if (signal || code) {
    logError(
      `AL language server proxy target exited${signal ? ` with signal ${signal}` : ` with code ${code}`}`,
    );
  }

  process.exitCode = exitCode;
  process.stdin.pause();
  process.stdout.end(() => process.exit(exitCode));
});

child.stdin.on("error", (error) => {
  logError(`failed writing to AL language server stdin: ${error.message}`);
  shutdown(1);
});

child.stdout.on("error", (error) => {
  logError(`failed reading AL language server stdout: ${error.message}`);
  shutdown(1);
});

process.stdin.on("end", () => {
  if (!child.stdin.destroyed) {
    child.stdin.end();
  }
});
process.stdin.on("error", (error) => {
  logError(`failed reading proxy stdin: ${error.message}`);
  child.stdin.destroy();
});
process.stdout.on("error", () => {
  shutdown(1);
});

const clientParser = createMessageParser((message) => {
  if (isProxyResponse(message)) {
    return;
  }

  trackClientRequests(message);
  analysis.onClientMessage(message);
  writeMessage(child.stdin, message);
}, "client");

const serverParser = createMessageParser((message) => {
  rewriteInitializeResponse(message);
  writeMessage(process.stdout, rewriteCompletionResponse(message));
}, "server");

process.stdin.on("data", (chunk) => safePush(clientParser, chunk));
child.stdout.on("data", (chunk) => safePush(serverParser, chunk));

function parseArguments(argv) {
  const separatorIndex = argv.indexOf("--");
  let proxyArgs;
  let rest;

  if (separatorIndex !== -1) {
    proxyArgs = argv.slice(2, separatorIndex);
    rest = argv.slice(separatorIndex + 1);
  } else {
    const entry = argv[1] || "";
    rest = /(?:^|[\\/])al-lsp-proxy\.js$/i.test(entry) ? argv.slice(2) : argv.slice(1);
    proxyArgs = [];
    while (rest.length && rest[0].startsWith("--")) {
      proxyArgs.push(rest.shift());
    }
  }

  while (rest[0] === "--") {
    rest.shift();
  }

  const options = { diagnostics: true, compileOnOpen: true };
  for (const arg of proxyArgs) {
    if (arg === "--no-diagnostics") {
      options.diagnostics = false;
    } else if (arg === "--no-compile-on-open") {
      options.compileOnOpen = false;
    } else if (arg.startsWith("--")) {
      logError(`ignoring unknown proxy option ${arg}`);
    }
  }

  return { options, serverCommand: rest[0], serverArgs: rest.slice(1) };
}

function createMessageParser(onMessage, name) {
  let buffer = Buffer.alloc(0);

  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);

      while (true) {
        const separator = findHeaderSeparator(buffer);
        const headerEnd = separator.index;
        if (headerEnd === -1) {
          return;
        }

        const header = buffer.subarray(0, headerEnd).toString("ascii");
        const lengthMatch = /^content-length:\s*(\d+)$/im.exec(header);
        if (!lengthMatch) {
          const recovered = recoverFromMalformedHeader(buffer, name);
          if (recovered.length === buffer.length) {
            throw new Error(`${name} LSP message missing Content-Length header`);
          }

          buffer = recovered;
          continue;
        }

        const contentLength = Number.parseInt(lengthMatch[1], 10);
        const bodyStart = headerEnd + separator.length;
        const messageEnd = bodyStart + contentLength;

        if (buffer.length < messageEnd) {
          return;
        }

        const body = buffer.subarray(bodyStart, messageEnd).toString("utf8");
        buffer = buffer.subarray(messageEnd);
        onMessage(JSON.parse(body));
      }
    },
  };
}

function safePush(parser, chunk) {
  try {
    parser.push(chunk);
  } catch (error) {
    logError(formatError(error));
    shutdown(1);
  }
}

function findHeaderSeparator(buffer) {
  const crlfIndex = buffer.indexOf("\r\n\r\n");
  const lfIndex = buffer.indexOf("\n\n");

  if (crlfIndex === -1) {
    return { index: lfIndex, length: lfIndex === -1 ? 0 : 2 };
  }

  if (lfIndex === -1 || crlfIndex < lfIndex) {
    return { index: crlfIndex, length: 4 };
  }

  return { index: lfIndex, length: 2 };
}

function recoverFromMalformedHeader(buffer, name) {
  const text = buffer.toString("ascii");
  const headerStart = text.search(/(?:^|\r?\n)content-length\s*:/i);

  if (headerStart > 0) {
    logError(`${name} emitted non-LSP stdout before headers; discarding ${headerStart} bytes`);
    return buffer.subarray(headerStart);
  }

  const separator = findHeaderSeparator(buffer);
  if (separator.index !== -1) {
    logError(`${name} emitted malformed LSP headers; discarding header block`);
    return buffer.subarray(separator.index + separator.length);
  }

  return buffer;
}

function writeMessage(stream, message) {
  const body = JSON.stringify(message);
  const length = Buffer.byteLength(body, "utf8");
  stream.write(`Content-Length: ${length}\r\n\r\n${body}`);
}

function sendToClient(message) {
  writeMessage(process.stdout, message);
}

function sendProxyRequest(method, params) {
  proxyRequestCounter += 1;
  sendToClient({
    jsonrpc: "2.0",
    id: `${PROXY_REQUEST_ID_PREFIX}${proxyRequestCounter}`,
    method,
    params,
  });
}

function isProxyResponse(message) {
  return (
    message &&
    !Array.isArray(message) &&
    typeof message.id === "string" &&
    message.id.startsWith(PROXY_REQUEST_ID_PREFIX) &&
    message.method === undefined
  );
}

function trackClientRequests(message) {
  visitMessages(message, (item) => {
    if (!item || item.id === undefined) {
      return;
    }

    if (item.method === "textDocument/completion") {
      completionRequestIds.add(JSON.stringify(item.id));
    } else if (item.method === "initialize") {
      initializeRequestIds.add(JSON.stringify(item.id));
    }
  });
}

// Make sure the client keeps sending `textDocument/didSave`, which drives the background compile.
function rewriteInitializeResponse(message) {
  visitMessages(message, (item) => {
    if (!item || item.id === undefined || !item.result) {
      return;
    }

    const key = JSON.stringify(item.id);
    if (!initializeRequestIds.delete(key)) {
      return;
    }

    const capabilities = item.result.capabilities;
    if (!capabilities || typeof capabilities !== "object") {
      return;
    }

    const sync = capabilities.textDocumentSync;
    if (sync === undefined || sync === null || typeof sync === "number") {
      capabilities.textDocumentSync = {
        openClose: true,
        change: typeof sync === "number" ? sync : 1,
        save: { includeText: false },
      };
    } else if (typeof sync === "object" && !sync.save) {
      sync.save = { includeText: false };
    }
  });
}

function rewriteCompletionResponse(message) {
  visitMessages(message, (item) => {
    if (!item || item.id === undefined || !Object.prototype.hasOwnProperty.call(item, "result")) {
      return;
    }

    const key = JSON.stringify(item.id);
    if (!completionRequestIds.delete(key)) {
      return;
    }

    rewriteCompletionResult(item.result);
  });

  return message;
}

function visitMessages(message, visitor) {
  if (Array.isArray(message)) {
    for (const item of message) {
      visitor(item);
    }
  } else {
    visitor(message);
  }
}

function rewriteCompletionResult(result) {
  if (Array.isArray(result)) {
    for (const item of result) {
      rewriteCompletionItem(item);
    }
    return;
  }

  if (result && Array.isArray(result.items)) {
    for (const item of result.items) {
      rewriteCompletionItem(item);
    }
  }
}

function rewriteCompletionItem(item) {
  if (!item || !item.label || typeof item.label !== "object" || Array.isArray(item.label)) {
    return;
  }

  const label = item.label;
  const replacement =
    stringOrEmpty(label.label) ||
    stringOrEmpty(item.filterText) ||
    stringOrEmpty(item.insertText) ||
    stringOrEmpty(item.detail) ||
    "";

  if (!item.labelDetails && (typeof label.detail === "string" || typeof label.description === "string")) {
    item.labelDetails = {};

    if (typeof label.detail === "string") {
      item.labelDetails.detail = label.detail;
    }

    if (typeof label.description === "string") {
      item.labelDetails.description = label.description;
    }
  }

  item.label = replacement;
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value : "";
}

// ---------------------------------------------------------------------------------------------
// Background code analysis
// ---------------------------------------------------------------------------------------------

function createBackgroundAnalysis({ alCommand, enabled, compileOnOpen }) {
  const projects = new Map();
  const projectRootCache = new Map();
  let analyzerDir;
  let analyzerDirResolved = false;

  if (!enabled) {
    return { onClientMessage() {} };
  }

  return { onClientMessage };

  function onClientMessage(message) {
    visitMessages(message, (item) => {
      if (!item || typeof item.method !== "string") {
        return;
      }

      if (item.method === "textDocument/didSave") {
        scheduleForDocument(item.params, "save");
      } else if (item.method === "textDocument/didOpen" && compileOnOpen) {
        scheduleForDocument(item.params, "open");
      }
    });
  }

  function scheduleForDocument(params, reason) {
    const uri = params && params.textDocument && params.textDocument.uri;
    const filePath = uriToPath(uri);
    if (!filePath || !/\.d?al$/i.test(filePath)) {
      return;
    }

    const root = findProjectRoot(filePath);
    if (!root) {
      return;
    }

    const project = getProject(root);
    if (reason === "open" && project.compiledOnce) {
      return;
    }

    project.compiledOnce = true;
    requestCompile(project);
  }

  function getProject(root) {
    let project = projects.get(root);
    if (!project) {
      project = {
        root,
        name: readAppName(root) || path.basename(root),
        running: false,
        pending: false,
        timer: null,
        compiledOnce: false,
        publishedFiles: new Set(),
      };
      projects.set(root, project);
    }
    return project;
  }

  function requestCompile(project) {
    if (project.running) {
      project.pending = true;
      return;
    }

    if (project.timer) {
      clearTimeout(project.timer);
    }

    project.timer = setTimeout(() => {
      project.timer = null;
      compileProject(project);
    }, COMPILE_DEBOUNCE_MS);
  }

  function compileProject(project) {
    project.running = true;
    project.pending = false;

    const token = `al-lsp-proxy/compile/${Date.now()}`;
    sendProxyRequest("window/workDoneProgress/create", { token });
    sendToClient({
      jsonrpc: "2.0",
      method: "$/progress",
      params: { token, value: { kind: "begin", title: `AL: compiling ${project.name}`, cancellable: false } },
    });

    const startedAt = Date.now();
    runCompile(project, (result) => {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      const summary = result.error
        ? `failed to run al compile: ${result.error}`
        : `${result.issues.length} diagnostic(s) in ${elapsed}s`;

      sendToClient({
        jsonrpc: "2.0",
        method: "$/progress",
        params: { token, value: { kind: "end", message: summary } },
      });

      if (result.error) {
        logError(`${project.name}: ${result.error}`);
        showMessage(2, `AL background analysis: ${result.error}`);
      } else {
        publishIssues(project, result.issues);

        if (result.exitCode !== 0 && !result.issues.some((issue) => issue.severity === "error")) {
          const tail = result.output.trim().split(/\r?\n/).filter(Boolean).slice(-3).join("\n");
          showMessage(2, `AL compile of ${project.name} failed (exit ${result.exitCode}).\n${tail}`);
        }

        logInfo(`${project.name}: ${summary}`);
      }

      project.running = false;
      if (project.pending) {
        requestCompile(project);
      }
    });
  }

  function runCompile(project, done) {
    const settings = readJsonc(path.join(project.root, ".vscode", "settings.json")) || {};
    const tempTag = `al-lsp-proxy-${process.pid}-${Date.now()}`;
    const errorLog = path.join(os.tmpdir(), `${tempTag}.json`);
    const outApp = path.join(os.tmpdir(), `${tempTag}.app`);

    const caches = toArray(settings["al.packageCachePath"]);
    const args = [
      "compile",
      `/project:${project.root}`,
      "/parallel",
      `/errorlog:${errorLog}`,
      `/out:${outApp}`,
      `/packagecachepath:${(caches.length ? caches : [".alpackages"])
        .map((entry) => resolveAgainst(project.root, entry))
        .join(",")}`,
    ];

    const probing = toArray(settings["al.assemblyProbingPaths"]);
    if (probing.length) {
      args.push(`/assemblyprobingpaths:${probing.map((entry) => resolveAgainst(project.root, entry)).join(",")}`);
    }

    if (typeof settings["al.ruleSetPath"] === "string" && settings["al.ruleSetPath"]) {
      args.push(`/ruleset:${resolveAgainst(project.root, settings["al.ruleSetPath"])}`);
    }

    for (const dll of resolveAnalyzers(project, toArray(settings["al.codeAnalyzers"]))) {
      args.push(`/analyzer:${dll}`);
    }

    let compiler;
    try {
      compiler = spawn(alCommand, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      done({ error: error.message });
      return;
    }

    let output = "";
    compiler.stdout.on("data", (chunk) => (output += chunk));
    compiler.stderr.on("data", (chunk) => (output += chunk));
    compiler.on("error", (error) => {
      cleanup();
      done({ error: error.message });
    });
    compiler.on("exit", (code) => {
      let issues = [];
      try {
        if (fs.existsSync(errorLog)) {
          issues = parseErrorLog(fs.readFileSync(errorLog, "utf8"), project.root);
        }
      } catch (error) {
        cleanup();
        done({ error: `could not read compiler error log: ${error.message}` });
        return;
      }

      cleanup();
      done({ exitCode: code ?? 1, issues, output });
    });

    function cleanup() {
      for (const file of [errorLog, outApp]) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // best effort
        }
      }
    }
  }

  function resolveAnalyzers(project, entries) {
    const dlls = [];

    for (const entry of entries) {
      if (typeof entry !== "string" || !entry) {
        continue;
      }

      const match = /^\$\{(\w+)\}(.*)$/.exec(entry);
      let dll;

      if (match) {
        const dir = getAnalyzerDir();
        if (!dir) {
          logError(`analyzer ${entry} skipped: analyzer folder not found in the al tool store`);
          continue;
        }

        if (match[1] === "analyzerFolder") {
          dll = path.join(dir, match[2].replace(/^[\\/]+/, ""));
        } else if (ANALYZER_DLLS[match[1]]) {
          dll = path.join(dir, ANALYZER_DLLS[match[1]]);
        } else {
          logError(`unknown analyzer token ${entry} skipped`);
          continue;
        }
      } else {
        dll = resolveAgainst(project.root, entry);
      }

      if (fs.existsSync(dll)) {
        dlls.push(dll);
      } else {
        logError(`analyzer not found, skipped: ${dll}`);
      }
    }

    return dlls;
  }

  // Analyzer DLLs ship in the dotnet tool store next to the compiler. Only the net8.0 build reports
  // diagnostics.
  function getAnalyzerDir() {
    if (analyzerDirResolved) {
      return analyzerDir;
    }

    analyzerDirResolved = true;
    for (const toolsDir of candidateToolDirs()) {
      const store = path.join(toolsDir, ".store", TOOL_PACKAGE);
      let versions;
      try {
        versions = fs
          .readdirSync(store, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort(compareVersionsDesc);
      } catch {
        continue;
      }

      for (const version of versions) {
        const dir = path.join(store, version, TOOL_PACKAGE, version, "tools", "net8.0", "any");
        if (fs.existsSync(path.join(dir, ANALYZER_DLLS.CodeCop))) {
          analyzerDir = dir;
          return analyzerDir;
        }
      }
    }

    return analyzerDir;
  }

  function candidateToolDirs() {
    const dirs = [];
    if (path.isAbsolute(alCommand)) {
      dirs.push(path.dirname(alCommand));
    }
    dirs.push(path.join(os.homedir(), ".dotnet", "tools"));
    return dirs;
  }

  function publishIssues(project, issues) {
    const byFile = new Map();

    for (const issue of issues) {
      const key = normalizePathKey(issue.file);
      if (!byFile.has(key)) {
        byFile.set(key, { file: issue.file, diagnostics: [] });
      }
      byFile.get(key).diagnostics.push(issue.diagnostic);
    }

    for (const key of project.publishedFiles) {
      if (!byFile.has(key)) {
        byFile.set(key, { file: key, diagnostics: [] });
      }
    }

    project.publishedFiles = new Set();
    for (const [key, entry] of byFile) {
      if (entry.diagnostics.length) {
        project.publishedFiles.add(key);
      }

      sendToClient({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri: pathToFileURL(entry.file).href, diagnostics: entry.diagnostics },
      });
    }
  }

  function findProjectRoot(filePath) {
    let dir = path.dirname(filePath);

    while (dir) {
      if (projectRootCache.has(dir)) {
        return projectRootCache.get(dir);
      }

      if (fs.existsSync(path.join(dir, "app.json"))) {
        projectRootCache.set(dir, dir);
        return dir;
      }

      const parent = path.dirname(dir);
      if (!parent || parent === dir) {
        break;
      }
      dir = parent;
    }

    return null;
  }

  function showMessage(type, message) {
    sendToClient({ jsonrpc: "2.0", method: "window/showMessage", params: { type, message } });
  }
}

function parseErrorLog(text, projectRoot) {
  const log = JSON.parse(text);
  const issues = [];

  for (const issue of toArray(log && log.issues)) {
    const severity = String((issue.properties && issue.properties.severity) || "").toLowerCase();
    const lspSeverity = SEVERITIES[severity];
    if (!lspSeverity) {
      continue;
    }

    const target =
      issue.locations && issue.locations[0] && issue.locations[0].analysisTarget && issue.locations[0].analysisTarget[0];
    const file = (target && uriToPath(target.uri)) || path.join(projectRoot, "app.json");
    const region = (target && target.region) || {};
    const startLine = Math.max(0, (Number(region.startLine) || 1) - 1);
    const startColumn = Math.max(0, (Number(region.startColumn) || 1) - 1);
    const endLine = Math.max(startLine, (Number(region.endLine) || startLine + 1) - 1);
    let endColumn = Math.max(0, (Number(region.endColumn) || startColumn + 2) - 1);
    if (endLine === startLine && endColumn <= startColumn) {
      endColumn = startColumn + 1;
    }

    const diagnostic = {
      range: { start: { line: startLine, character: startColumn }, end: { line: endLine, character: endColumn } },
      severity: lspSeverity,
      source: "al",
      message: issue.shortMessage || issue.fullMessage || issue.ruleId || "AL diagnostic",
    };

    if (issue.ruleId) {
      diagnostic.code = issue.ruleId;
    }

    const helpLink = issue.properties && issue.properties.helpLink;
    if (typeof helpLink === "string" && /^https?:\/\//.test(helpLink)) {
      diagnostic.codeDescription = { href: helpLink };
    }

    issues.push({ file, severity, diagnostic });
  }

  return issues;
}

function uriToPath(uri) {
  if (typeof uri !== "string" || !uri) {
    return null;
  }

  if (/^file:/i.test(uri)) {
    try {
      return path.normalize(fileURLToPath(uri));
    } catch {
      return null;
    }
  }

  return path.normalize(uri);
}

function normalizePathKey(filePath) {
  const normalized = path.normalize(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function readAppName(root) {
  const manifest = readJsonc(path.join(root, "app.json"));
  return manifest && typeof manifest.name === "string" ? manifest.name : null;
}

function readJsonc(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }

  text = text.replace(/^﻿/, "");
  text = text.replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (match, string) => string || "");
  text = text.replace(/,(\s*[}\]])/g, "$1");

  try {
    return JSON.parse(text);
  } catch (error) {
    logError(`could not parse ${file}: ${error.message}`);
    return null;
  }
}

function resolveAgainst(root, entry) {
  return path.isAbsolute(entry) ? entry : path.join(root, entry);
}

function toArray(value) {
  if (Array.isArray(value)) {
    return value.filter((entry) => entry !== null && entry !== undefined && entry !== "");
  }
  return value === null || value === undefined || value === "" ? [] : [value];
}

function compareVersionsDesc(a, b) {
  const pa = a.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function shutdown(code) {
  process.exitCode = code;

  if (!child.killed) {
    child.kill();
  }

  process.stdin.pause();
}

function logInfo(message) {
  process.stderr.write(`[al-lsp-proxy] ${message}\n`);
}

function logError(message) {
  process.stderr.write(`[al-lsp-proxy] ${message}\n`);
}

function formatError(error) {
  if (error && error.stack) {
    return error.stack;
  }

  if (error && error.message) {
    return error.message;
  }

  return String(error);
}
