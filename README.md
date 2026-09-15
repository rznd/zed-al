# AL for Zed

AL language support for [Zed](https://zed.dev), targeting Microsoft Dynamics 365 Business Central development.

> Fork of [Barne-B/zed-al-language](https://github.com/Barne-B/zed-al-language) maintained by [rznd](https://github.com/rznd). Changes over upstream:
>
> - **Monorepo detection.** When the worktree root has no `app.json`, the adapter looks for `all.code-workspace`, `workspace.code-workspace` or `<folder>.code-workspace` at the root and starts ALTool with `--workspacefile`, so every app listed there is loaded (cross-app navigation works). `--packagecachepath` is only pinned for single-app worktrees or when configured; `--settingspath` falls back to the `.vscode/settings.json` of the first workspace folder that has one.
> - **`AL: Compile` task.** Zed has no problems panel, so `scripts/al-compile.ps1` finds the `app.json` above the current file, applies analyzers, ruleset and package cache from that project's `.vscode/settings.json`, runs `al compile` and prints diagnostics as `file:line:col: severity CODE: message` (clickable in Zed's terminal). See `tasks.example.json`; copy it to `%APPDATA%\Zed	asks.json` (Windows) or `~/.config/zed/tasks.json` and fix the script path.
> - `.dal` files, block comments and bracket pairs in the language config.
>
> Install as a dev extension: `zed: install dev extension` → select this folder. Requires Rust via rustup (on Windows without MSVC Build Tools: `rustup default stable-x86_64-pc-windows-gnu`). Zed adds the `wasm32-wasip*` target and downloads the wasi-sdk for the tree-sitter grammar itself.

This extension provides:

- `.al` file detection.
- Tree-sitter syntax highlighting, brackets, indentation, folding, and outline support via [`SShadowS/tree-sitter-al`](https://github.com/SShadowS/tree-sitter-al).
- Language Server Protocol support through Microsoft ALTool's standalone LSP command.
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

### Completion Deserialization Errors

If Zed logs an error like `failed to deserialize response from language server: invalid type: map, expected a string` for a completion response containing `"label":{"label":"..."}`, the AL language server is returning a VS Code-style completion label object in the LSP `CompletionItem.label` field. Standard LSP requires `CompletionItem.label` to be a string; structured label metadata belongs in `CompletionItem.labelDetails`.

This is not caused by `snippets/al.json`, and it cannot be corrected by this extension's `label_for_completion` hook because Zed only calls that hook after completion items have already deserialized successfully. The current `zed_extension_api` lets this extension provide the language server command, initialization options, and workspace configuration, but it does not expose a hook to rewrite raw LSP responses or override Zed's LSP client capabilities.

As an opt-in workaround, the extension can launch ALTool through a small stdio proxy that rewrites completion responses before Zed deserializes them. The proxy preserves the normal ALTool arguments and only changes completion items whose `label` is an object, replacing it with `label.label` when present and falling back to `filterText`, `insertText`, or `detail`.

```json
{
  "lsp": {
    "al": {
      "settings": {
        "useCompletionProxy": true
      }
    }
  }
}
```

The proxy uses Zed's Node runtime (`node_binary_path`, including Volta-managed installs on Windows) and launches `scripts/al-lsp-proxy.js` by absolute path from the extension working directory (`PWD`). The script ships in this repository next to `extension.wasm`; it is not embedded with `node -e` or `AL_LSP_PROXY_SCRIPT`. Optional `lsp.al.binary.env` entries are still forwarded when set, but the proxy does not depend on custom env vars reaching the LSP process. It is still a workaround: it only covers malformed completion responses, adds one local process between Zed and ALTool, and should be removed once ALTool or Zed handles the invalid response shape directly. If the proxy causes trouble, remove `useCompletionProxy` to return to the normal LSP path.

## Development

Install this folder as a Zed dev extension:

1. Open Zed's Extensions page.
2. Run `zed: install dev extension`.
3. Select this repository folder.

For local validation, open an AL project containing `app.json`, at least one `.al` file, and the required `.app` symbol packages. Then verify syntax highlighting and LSP features such as hover, completions, go-to-definition, diagnostics, formatting, and rename.

If the language server does not start, check Zed's log for missing `al`/`altool`, invalid package cache paths, or missing symbol packages.

To smoke test the optional completion proxy without ALTool, run:

```sh
node scripts/test-al-lsp-proxy.js
```
