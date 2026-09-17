# AL for Zed

AL language support for [Zed](https://zed.dev), targeting Microsoft Dynamics 365 Business Central development.

> Fork of [Barne-B/zed-al-language](https://github.com/Barne-B/zed-al-language) maintained by [rznd](https://github.com/rznd). Changes over upstream:
>
> - **Monorepo detection.** When the worktree root has no `app.json`, the adapter looks for `all.code-workspace`, `workspace.code-workspace` or `<folder>.code-workspace` at the root and starts ALTool with `--workspacefile`, so every app listed there is loaded (cross-app navigation works). `--packagecachepath` is only pinned for single-app worktrees or when configured; `--settingspath` falls back to the `.vscode/settings.json` of the first workspace folder that has one.
> - **Background code analysis.** ALTool's `launchlspserver` never publishes diagnostics, so the extension launches it through a small stdio proxy (`scripts/al-lsp-proxy.js`, on Zed's Node runtime). On save, and when the first file of a project is opened, the proxy runs `al compile` for the app that owns the file, with the analyzers, ruleset and package cache from that app's `.vscode/settings.json`, and publishes the result as LSP diagnostics. Errors and warnings show up in the buffer and in Zed's project diagnostics panel. See [Background Code Analysis](#background-code-analysis).
- **`AL: Compile` task.** Manual alternative to the above: `scripts/al-compile.ps1` finds the `app.json` above the current file, applies analyzers, ruleset and package cache from that project's `.vscode/settings.json`, runs `al compile` and prints diagnostics as `file:line:col: severity CODE: message` (clickable in Zed's terminal). See `tasks.example.json`; copy it to `%APPDATA%\Zed\tasks.json` (Windows) or `~/.config/zed/tasks.json` and fix the script path.
> - `.dal` files, block comments and bracket pairs in the language config.
>
> Install as a dev extension: `zed: install dev extension` → select this folder. Requires Rust via rustup (on Windows without MSVC Build Tools: `rustup default stable-x86_64-pc-windows-gnu`). Zed adds the `wasm32-wasip*` target and downloads the wasi-sdk for the tree-sitter grammar itself.

This extension provides:

- `.al` file detection.
- Tree-sitter syntax highlighting, brackets, indentation, folding, and outline support via [`SShadowS/tree-sitter-al`](https://github.com/SShadowS/tree-sitter-al).
- Language Server Protocol support through Microsoft ALTool's standalone LSP command.
- Compiler and code analyzer diagnostics (errors, warnings, info) in the buffer and in the project diagnostics panel, compiled in the background on save.
- Snippets for common AL objects and constructs.
- A file-scoped slash command for finding next free AL IDs.

## Requirements

Install ALTool and make sure either `al` or `altool` is available on your `PATH`.

Microsoft recommends installing the Business Central development tools as a .NET global tool:

```sh
dotnet tool install --global Microsoft.Dynamics.BusinessCentral.Development.Tools
```

The language server is launched over stdio with:

```sh
al launchlspserver "<path-to-project>" --packagecachepath "<symbols>"
```

## Snippets and Templates

The extension contributes Zed/VS Code-style snippets from `snippets/al.json`. Type a prefix in an `.al` file and accept the completion to scaffold common Business Central constructs:

- `altable`, `altableext`, `alpage`, `alpageext`, `alcodeunit`, `alreport`, and `alenum` for object templates.
- `alprocedure` and `altrigger` for common members.
- `altestcodeunit` and `altest` for test code.
- `alsubscriber` and `alevent` for event subscriber and integration event patterns.

## Next Free ID

The extension provides an assistant slash command:

```text
/al-next-id path/to/Object.al [line]
```

It reads the `.al` file from the current worktree and reports:

- The next free object ID found within that file.
- The next free `field(...)` ID inside table and tableextension objects.
- The next free enum `value(...)` ID inside enum and enumextension objects.

When the file contains multiple objects, pass a line number inside the object you want to inspect:

```text
/al-next-id src/MyTable.al 42
```

Zed extension slash commands receive a worktree but not the active editor, current buffer, or cursor position. Because of that, `/al-next-id` cannot automatically infer the currently open object; pass the relative file path, and optionally a line number, to target the desired object. The reported object ID is file-scoped only and is not a project-wide allocation check.

## IntelliSense and LSP Setup

The extension uses the current Zed worktree root as the AL project path and passes `.alpackages` as the default symbol package cache:

```sh
al launchlspserver "<worktree-root>" --packagecachepath "<worktree-root>/.alpackages"
```

Download or copy your dependency `.app` packages into `<worktree-root>/.alpackages` for the default setup. If your symbols live somewhere else, configure `packageCachePath`.

When `.vscode/settings.json` exists in the worktree, the adapter automatically passes it as `--settingspath "<worktree-root>/.vscode/settings.json"`. You can still override this with `settingsPath` in Zed settings.

For cross-app navigation in a workspace with multiple AL apps, pass every app folder to ALTool:

```json
{
  "lsp": {
    "al": {
      "settings": {
        "projects": [
          "BaseApp",
          "MyDependencyApp",
          "MyMainApp"
        ],
        "packageCachePath": "C:\\path\\to\\symbols"
      }
    }
  }
}
```

Relative `projects` entries are resolved from the Zed worktree root. You can also use absolute paths. ALTool reads each project's `app.json` and resolves dependency relationships so hover, completions, go-to-definition, and find-references can work across those apps.

Recommended Zed settings for a typical multi-app workspace:

```json
{
  "lsp": {
    "al": {
      "settings": {
        "projects": [
          "BaseApp",
          "MyDependencyApp",
          "MyMainApp"
        ],
        "packageCachePath": ".alpackages",
        "logLevel": "Warning"
      }
    }
  }
}
```

The adapter also accepts these optional settings:

- `settingsPath`: passed as `--settingspath`.
- `workspaceFile`: passed as `--workspacefile`.
- `logFile`: passed as `--logfile`.
- `logLevel`: passed as `--loglevel`.
- `projects` or `projectPaths`: AL project folders passed as positional `launchlspserver` project arguments.
- `packageCachePath` or `packageCachePaths`: symbol package cache path or paths passed as `--packagecachepath`.

You can override the executable or full argument list with Zed's standard LSP binary settings:

```json
{
  "lsp": {
    "al": {
      "binary": {
        "path": "C:\\path\\to\\al.exe",
        "arguments": [
          "launchlspserver",
          "C:\\path\\to\\project",
          "--packagecachepath",
          "C:\\path\\to\\symbols"
        ]
      }
    }
  }
}
```

When `binary.arguments` is set, it replaces the default generated arguments.

Semantic tokens are provided by ALTool when supported by the active language server. This extension does not add custom semantic token remapping, so highlighting remains driven by Tree-sitter plus the LSP capabilities reported by ALTool.

### Background Code Analysis

ALTool's `launchlspserver` (18.0.41 at the time of writing) registers no diagnostics endpoint and never sends `textDocument/publishDiagnostics`, even with an error in the open file. It also ignores `al.backgroundCodeAnalysis` from `settings.json`. Zed extensions cannot produce diagnostics themselves, so the extension launches ALTool through `scripts/al-lsp-proxy.js`, a stdio proxy running on Zed's Node runtime (`node_binary_path`), and the proxy fills the gap:

1. When Zed sends `textDocument/didSave` (or `textDocument/didOpen` for the first file of a project), the proxy walks up from the file to the nearest `app.json`.
2. It reads that project's `.vscode/settings.json` (`al.packageCachePath`, `al.assemblyProbingPaths`, `al.ruleSetPath`, `al.codeAnalyzers` with the `${CodeCop}`, `${UICop}`, `${AppSourceCop}`, `${PerTenantExtensionCop}` and `${analyzerFolder}` tokens resolved against the ALTool tool store) and runs `al compile /project:<app> /parallel /errorlog:<tmp> /out:<tmp>`. The `.app` goes to the temp folder and is deleted afterwards.
3. The error log is converted into one `publishDiagnostics` notification per file (severity, rule ID, message and help link). Files whose diagnostics disappeared get an empty list, so stale markers are cleared.

Compiles for the same app are debounced and never overlap; a save during a compile queues one more run. Progress is reported through `window/workDoneProgress`, and a compile that fails without producing diagnostics (missing symbols, for instance) shows the compiler's last lines as a Zed notification. In a multi-app worktree each app is compiled on its own, exactly like VS Code's `al.backgroundCodeAnalysis: "Project"`.

Limitations: only the saved state is analyzed, not the buffer being edited, and each run is a full compile of that app (about 16 s for a 400-object app with the three Microsoft analyzers; a few seconds for small apps). The `AL: Compile` task remains available as a manual alternative.

Settings (under `lsp.al.settings`):

```json
{
  "lsp": {
    "al": {
      "settings": {
        "backgroundCodeAnalysis": "Project"
      }
    }
  }
}
```

- `backgroundCodeAnalysis`: `"Project"` (default) compiles on save and when the first file of an app is opened; `"Save"` compiles on save only; `"Off"` (or `false`) disables the background compile. The proxy is then launched with `--no-compile-on-open` or `--no-diagnostics`.
- `useProxy`: set to `false` to launch ALTool directly, without the proxy. This also disables background code analysis and the completion fix below. Not needed with `binary.arguments`, which the proxy passes through unchanged.

### Completion Deserialization Errors

The AL language server returns VS Code-style completion label objects (`"label":{"label":"..."}`) in the LSP `CompletionItem.label` field, which Zed cannot deserialize (`failed to deserialize response from language server: invalid type: map, expected a string`). Standard LSP requires `CompletionItem.label` to be a string; structured label metadata belongs in `CompletionItem.labelDetails`.

This is not caused by `snippets/al.json`, and it cannot be corrected by this extension's `label_for_completion` hook because Zed only calls that hook after completion items have already deserialized successfully. The same proxy that provides background code analysis rewrites completion items whose `label` is an object, replacing it with `label.label` when present and falling back to `filterText`, `insertText`, or `detail`, and moving `detail`/`description` into `labelDetails`. The rewrite should be removed once ALTool or Zed handles the invalid response shape directly.

The script ships in this repository next to `extension.wasm`; when the extension is installed without the `scripts/` folder, the embedded copy is materialized into the extension working directory. Optional `lsp.al.binary.env` entries are still forwarded when set.

## Development

Install this folder as a Zed dev extension:

1. Open Zed's Extensions page.
2. Run `zed: install dev extension`.
3. Select this repository folder.

For local validation, open an AL project containing `app.json`, at least one `.al` file, and the required `.app` symbol packages. Then verify syntax highlighting and LSP features such as hover, completions, go-to-definition, diagnostics, formatting, and rename.

If the language server does not start, check Zed's log for missing `al`/`altool`, invalid package cache paths, or missing symbol packages.

To test the proxy (completion rewrite and background code analysis) without ALTool, run:

```sh
node scripts/test-al-lsp-proxy.js
```
