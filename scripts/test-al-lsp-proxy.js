const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const proxyScript = path.resolve("scripts/al-lsp-proxy.js");

run().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

async function run() {
  await runInitializeTest("script file path");
  await runCompletionRewriteTest("script file path");
  await runBackgroundAnalysisTest();
  await runDisabledAnalysisTest();
}

function runInitializeTest(name, options = {}) {
  const mockServer = String.raw`
    runServer((request) => {
      if (request.method !== "initialize") {
        process.exit(4);
      }

      return { jsonrpc: "2.0", id: request.id, result: { capabilities: { textDocumentSync: 1 } } };
    });

    ${mockServerSource()}
  `;

  return runProxyTest({
    name: `initialize (${name})`,
    mockServer,
    requests: [{ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } }],
    ...options,
    onMessage(response) {
      if (response.id !== 1 || !response.result || !response.result.capabilities) {
        throw new Error(`bad initialize response: ${JSON.stringify(response)}`);
      }

      const sync = response.result.capabilities.textDocumentSync;
      if (!sync || sync.change !== 1 || !sync.save) {
        throw new Error(`textDocumentSync was not extended with save: ${JSON.stringify(sync)}`);
      }

      return true;
    },
  });
}

function runCompletionRewriteTest(name, options = {}) {
  const mockServer = String.raw`
    runServer((request) => {
      if (request.method !== "textDocument/completion") {
        process.exit(4);
      }

      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          items: [
            {
              label: { label: "field", detail: " detail", description: " desc" },
              filterText: "fallback",
            },
          ],
        },
      };
    });

    ${mockServerSource()}
  `;

  return runProxyTest({
    name: `completion rewrite (${name})`,
    mockServer,
    requests: [
      {
        jsonrpc: "2.0",
        id: 2,
        method: "textDocument/completion",
        params: {},
      },
    ],
    ...options,
    onMessage(response) {
      const item = response.result && response.result.items && response.result.items[0];

      if (!item) {
        throw new Error(`missing completion item: ${JSON.stringify(response)}`);
      }

      if (item.label !== "field") {
        throw new Error(`label was not rewritten: ${JSON.stringify(item.label)}`);
      }

      if (!item.labelDetails || item.labelDetails.detail !== " detail") {
        throw new Error(`missing labelDetails.detail: ${JSON.stringify(item)}`);
      }

      if (item.labelDetails.description !== " desc") {
        throw new Error(`missing labelDetails.description: ${JSON.stringify(item)}`);
      }

      return true;
    },
  });
}

// The proxy runs `<server-command> compile ...` for the saved file's project. In the tests the
// server command is node itself, so a NODE_OPTIONS --require hook plays the compiler and writes
// the error log the proxy expects.
async function runBackgroundAnalysisTest() {
  const fixture = createProjectFixture();
  const mockServer = String.raw`
    runServer((request) => {
      if (request.method === "initialize") {
        return { jsonrpc: "2.0", id: request.id, result: { capabilities: { textDocumentSync: 1 } } };
      }
      return null;
    });

    ${mockServerSource()}
  `;

  const seen = { progressCreate: false, progressBegin: false, progressEnd: false };

  try {
    await runProxyTest({
      name: "background analysis publishes diagnostics",
      mockServer,
      env: { NODE_OPTIONS: `--require "${fixture.fakeCompiler.split(path.sep).join("/")}"` },
      timeoutMs: 10000,
      requests: [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
        {
          jsonrpc: "2.0",
          method: "textDocument/didSave",
          params: { textDocument: { uri: pathToFileURL(fixture.sourceFile).href } },
        },
      ],
      onMessage(message) {
        if (message.method === "window/workDoneProgress/create") {
          seen.progressCreate = true;
          return false;
        }

        if (message.method === "$/progress") {
          seen[message.params.value.kind === "begin" ? "progressBegin" : "progressEnd"] = true;
          return false;
        }

        if (message.method !== "textDocument/publishDiagnostics") {
          return false;
        }

        const expectedUri = pathToFileURL(fixture.sourceFile).href.toLowerCase();
        if (String(message.params.uri).toLowerCase() !== expectedUri) {
          throw new Error(`diagnostics published for unexpected uri: ${message.params.uri}`);
        }

        const [error, warning, ...rest] = message.params.diagnostics;
        if (rest.length || !error || !warning) {
          throw new Error(`expected 2 diagnostics: ${JSON.stringify(message.params.diagnostics)}`);
        }

        if (error.severity !== 1 || error.code !== "AL0118" || error.range.start.line !== 4 || error.range.start.character !== 8) {
          throw new Error(`bad error diagnostic: ${JSON.stringify(error)}`);
        }

        if (error.range.end.line !== 4 || error.range.end.character !== 30) {
          throw new Error(`bad error range end: ${JSON.stringify(error.range)}`);
        }

        if (warning.severity !== 2 || warning.code !== "AA0073" || warning.codeDescription.href !== "https://example.test/aa0073") {
          throw new Error(`bad warning diagnostic: ${JSON.stringify(warning)}`);
        }

        if (!seen.progressCreate || !seen.progressBegin) {
          throw new Error("progress was not reported before diagnostics");
        }

        return true;
      },
    });

    const compiledArgs = JSON.parse(fs.readFileSync(fixture.argsFile, "utf8"));
    const expectations = [
      ["project", `/project:${fixture.root}`],
      ["errorlog", "/errorlog:"],
      ["out", "/out:"],
      ["packagecachepath", `/packagecachepath:${path.join(fixture.root, "symbols")}`],
      ["ruleset", `/ruleset:${path.join(fixture.root, "app.ruleset.json")}`],
      ["analyzer", `/analyzer:${path.join(fixture.root, "Custom.dll")}`],
    ];
    for (const [label, prefix] of expectations) {
      if (!compiledArgs.some((arg) => arg.startsWith(prefix))) {
        throw new Error(`compiler was not given ${label}: ${JSON.stringify(compiledArgs)}`);
      }
    }
    if (compiledArgs.some((arg) => arg.includes("${CodeCop}"))) {
      throw new Error(`unresolved analyzer token passed to the compiler: ${JSON.stringify(compiledArgs)}`);
    }

    console.log("ok - compiler arguments");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function runDisabledAnalysisTest() {
  const fixture = createProjectFixture();
  const mockServer = String.raw`
    runServer((request) => {
      if (request.method === "initialize") {
        return { jsonrpc: "2.0", id: request.id, result: { capabilities: {} } };
      }
      if (request.method === "textDocument/didSave") {
        return { jsonrpc: "2.0", method: "mock/sawSave", params: {} };
      }
      return null;
    });

    ${mockServerSource()}
  `;

  try {
    await runProxyTest({
      name: "--no-diagnostics skips the compile",
      mockServer,
      proxyOptions: ["--no-diagnostics"],
      env: { NODE_OPTIONS: `--require "${fixture.fakeCompiler.split(path.sep).join("/")}"` },
      requests: [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
        {
          jsonrpc: "2.0",
          method: "textDocument/didSave",
          params: { textDocument: { uri: pathToFileURL(fixture.sourceFile).href } },
        },
      ],
      onMessage(message) {
        if (message.method === "window/workDoneProgress/create" || message.method === "textDocument/publishDiagnostics") {
          throw new Error(`analysis ran although disabled: ${message.method}`);
        }
        return message.method === "mock/sawSave";
      },
    });

    if (fs.existsSync(fixture.argsFile)) {
      throw new Error("compiler was invoked although diagnostics are disabled");
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

function createProjectFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "al-lsp-proxy-test-"));
  const sourceFile = path.join(root, "src", "Test.Codeunit.al");
  const argsFile = path.join(root, "compile-args.json");
  const fakeCompiler = path.join(root, "fake-al.js");

  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, ".vscode"));
  fs.writeFileSync(path.join(root, "app.json"), JSON.stringify({ name: "Fixture App" }));
  fs.writeFileSync(sourceFile, "codeunit 50100 Test\n{\n}\n");
  fs.writeFileSync(path.join(root, "Custom.dll"), "");
  fs.writeFileSync(
    path.join(root, ".vscode", "settings.json"),
    [
      "{",
      "  // jsonc is allowed here",
      '  "al.packageCachePath": "symbols",',
      '  "al.ruleSetPath": "app.ruleset.json",',
      '  "al.codeAnalyzers": ["${CodeCop}", "Custom.dll",],',
      "}",
    ].join("\n"),
  );

  const errorLog = {
    issues: [
      {
        ruleId: "AL0118",
        locations: [
          {
            analysisTarget: [
              {
                uri: sourceFile,
                region: { startLine: 5, startColumn: 9, endLine: 5, endColumn: 31 },
              },
            ],
          },
        ],
        shortMessage: "The name 'Foo' does not exist in the current context",
        properties: { severity: "Error" },
      },
      {
        ruleId: "AA0073",
        locations: [
          {
            analysisTarget: [
              {
                uri: pathToFileURL(sourceFile).href,
                region: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 9 },
              },
            ],
          },
        ],
        shortMessage: "Temp prefix missing",
        properties: { severity: "Warning", helpLink: "https://example.test/aa0073" },
      },
      {
        ruleId: "AL0999",
        locations: [{ analysisTarget: [{ uri: sourceFile, region: { startLine: 1, startColumn: 1 } }] }],
        shortMessage: "hidden ones are dropped",
        properties: { severity: "Hidden" },
      },
    ],
  };

  fs.writeFileSync(
    fakeCompiler,
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'if (process.argv.slice(1).some((arg) => path.basename(arg) === "compile")) {',
      `  fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(1)));`,
      '  const errorLog = process.argv.find((arg) => arg.startsWith("/errorlog:"));',
      `  fs.writeFileSync(errorLog.slice("/errorlog:".length), ${JSON.stringify(JSON.stringify(errorLog))});`,
      "  process.exit(1);",
      "}",
    ].join("\n"),
  );

  return { root, sourceFile, argsFile, fakeCompiler };
}

function runProxyTest({ name, mockServer, requests, onMessage, proxyOptions = [], env = {}, timeoutMs = 3000 }) {
  return new Promise((resolve, reject) => {
    const serverArgs = ["--", process.execPath, "-e", mockServer];
    const proxyArgs = [proxyScript, ...proxyOptions, ...serverArgs];

    const proxy = spawn(process.execPath, proxyArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = Buffer.alloc(0);
    let stderr = "";
    let completed = false;

    const finish = (error) => {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeout(timer);
      proxy.kill();
      if (error) {
        reject(error);
      } else {
        console.log(`ok - ${name}`);
        resolve();
      }
    };

    const timer = setTimeout(() => {
      finish(new Error(`${name} proxy test timed out\n${stderr}`));
    }, timeoutMs);

    proxy.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    proxy.stdout.on("data", (chunk) => {
      try {
        stdout = Buffer.concat([stdout, chunk]);

        while (true) {
          const response = tryReadMessage(stdout);
          if (!response) {
            return;
          }

          stdout = stdout.subarray(response.bytesRead);
          if (onMessage(response.message)) {
            finish();
            return;
          }
        }
      } catch (error) {
        finish(error);
      }
    });

    proxy.on("exit", (code) => {
      if (!completed) {
        finish(new Error(`${name} proxy exited before response: ${code}\n${stderr}`));
      }
    });

    for (const request of requests) {
      writeMessage(proxy.stdin, request);
    }
  });
}

function tryReadMessage(buffer) {
  const text = buffer.toString("utf8");
  const separatorIndex = text.indexOf("\r\n\r\n");

  if (separatorIndex === -1) {
    return null;
  }

  const lengthMatch = /^content-length:\s*(\d+)$/im.exec(text.slice(0, separatorIndex));
  if (!lengthMatch) {
    throw new Error("proxy response missing Content-Length");
  }

  const bodyStart = Buffer.byteLength(text.slice(0, separatorIndex), "utf8") + 4;
  const bodyEnd = bodyStart + Number(lengthMatch[1]);

  if (buffer.length < bodyEnd) {
    return null;
  }

  return {
    message: JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8")),
    bytesRead: bodyEnd,
  };
}

function writeMessage(stream, message) {
  const body = JSON.stringify(message);
  stream.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function mockServerSource() {
  return String.raw`
    function runServer(handleRequest) {
      let buffer = Buffer.alloc(0);

      process.stdin.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);

        while (true) {
          const text = buffer.toString("utf8");
          const separatorIndex = text.indexOf("\r\n\r\n");

          if (separatorIndex === -1) {
            return;
          }

          const lengthMatch = /^content-length:\s*(\d+)$/im.exec(text.slice(0, separatorIndex));
          if (!lengthMatch) {
            process.exit(3);
          }

          const bodyStart = separatorIndex + 4;
          const bodyEnd = bodyStart + Number(lengthMatch[1]);

          if (buffer.length < bodyEnd) {
            return;
          }

          const request = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
          buffer = buffer.subarray(bodyEnd);

          const response = handleRequest(request);
          if (response) {
            writeMessage(process.stdout, response);
          }
        }
      });
    }

    function writeMessage(stream, message) {
      const body = JSON.stringify(message);
      stream.write("Content-Length: " + Buffer.byteLength(body) + "\r\n\r\n" + body);
    }
  `;
}
