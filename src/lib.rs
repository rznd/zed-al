use zed::settings::LspSettings;
use zed_extension_api as zed;

const LANGUAGE_SERVER_ID: &str = "al";
const DEFAULT_BINARY_NAME: &str = "al";
const FALLBACK_BINARY_NAME: &str = "altool";
const DEFAULT_PACKAGE_CACHE_PATH: &str = ".alpackages";
const DEFAULT_SETTINGS_PATH: &str = ".vscode/settings.json";
const APP_MANIFEST: &str = "app.json";
/// Workspace files tried, in order, when the worktree root is not itself an AL app.
const WORKSPACE_FILE_CANDIDATES: &[&str] = &["all.code-workspace", "workspace.code-workspace"];
const NEXT_ID_COMMAND: &str = "al-next-id";
const PROXY_SCRIPT_REL: &str = "scripts/al-lsp-proxy.js";
const PROXY_SCRIPT_NAME: &str = "al-lsp-proxy.js";
const EMBEDDED_PROXY_SCRIPT: &str = include_str!("../scripts/al-lsp-proxy.js");

/// When the proxy compiles the project that owns a buffer and publishes the diagnostics.
#[derive(Clone, Copy, PartialEq, Eq)]
enum BackgroundCodeAnalysis {
    /// On save and when the first file of a project is opened (default).
    Project,
    /// Only on save.
    Save,
    Off,
}

struct AlExtension {
    /// Zed sets `PWD` to the extension working directory for WASM extensions.
    extension_work_dir: String,
    proxy_script_path: Option<String>,
}

impl AlExtension {
    fn language_server_settings(worktree: &zed::Worktree) -> zed::Result<LspSettings> {
        LspSettings::for_worktree(LANGUAGE_SERVER_ID, worktree)
    }

    fn resolve_command(settings: &LspSettings, worktree: &zed::Worktree) -> zed::Result<String> {
        if let Some(path) = settings
            .binary
            .as_ref()
            .and_then(|binary| binary.path.as_ref())
        {
            return Ok(path.clone());
        }

        worktree
            .which(DEFAULT_BINARY_NAME)
            .or_else(|| worktree.which(FALLBACK_BINARY_NAME))
            .ok_or_else(|| {
                format!(
                    "Could not find `{DEFAULT_BINARY_NAME}` on PATH. Install Microsoft.Dynamics.BusinessCentral.Development.Tools or configure lsp.{LANGUAGE_SERVER_ID}.binary.path."
                )
            })
    }

    fn resolve_args(settings: &LspSettings, worktree: &zed::Worktree) -> Vec<String> {
        if let Some(arguments) = settings
            .binary
            .as_ref()
            .and_then(|binary| binary.arguments.as_ref())
        {
            return arguments.clone();
        }

        let mut args = vec!["launchlspserver".to_string()];
        let projects = setting_strings(settings, &["projects", "projectPaths", "project_paths"]);
        let explicit_workspace_file =
            setting_string(settings, &["workspaceFile", "workspace_file"]);
        let root_is_project = worktree.read_text_file(APP_MANIFEST).is_ok();

        // Where the AL projects are, in order of preference:
        // 1. `projects` setting            — explicit list of app folders;
        // 2. `workspaceFile` setting       — a .code-workspace whose folders are the apps;
        // 3. app.json at the worktree root — a single-app worktree;
        // 4. a .code-workspace at the root — a monorepo like locbr/all.code-workspace;
        // 5. the worktree root itself      — ALTool's own default.
        let mut workspace_file = explicit_workspace_file
            .as_deref()
            .map(|path| resolve_worktree_path(worktree, path));

        if !projects.is_empty() {
            args.extend(
                projects
                    .into_iter()
                    .map(|project| resolve_worktree_path(worktree, &project)),
            );
        } else if workspace_file.is_some() {
        } else if root_is_project {
            args.push(worktree.root_path());
        } else if let Some(found) = discover_workspace_file(worktree) {
            workspace_file = Some(resolve_worktree_path(worktree, &found));
        } else {
            args.push(worktree.root_path());
        }

        // Only pin the symbol cache when it is configured or when the worktree is one app; in a
        // multi-app workspace every project defaults to its own .alpackages.
        let configured_cache = setting_path_list(
            settings,
            &[
                "packageCachePath",
                "packageCachePaths",
                "package_cache_path",
            ],
        );
        let package_cache_path = match configured_cache {
            Some(path) => Some(path),
            None if root_is_project => Some(join_paths(
                &worktree.root_path(),
                DEFAULT_PACKAGE_CACHE_PATH,
            )),
            None => None,
        };
        if let Some(package_cache_path) = package_cache_path {
            args.push("--packagecachepath".to_string());
            args.push(package_cache_path);
        }

        // ALTool only auto-discovers `.vscode/settings.json` under the LSP root, which in a
        // multi-app worktree is the monorepo root. Fall back to the first app of the workspace
        // that has one, so analyzers and ruleset still reach the server.
        if let Some(settings_path) = setting_string(settings, &["settingsPath", "settings_path"]) {
            args.push("--settingspath".to_string());
            args.push(settings_path);
        } else if worktree.read_text_file(DEFAULT_SETTINGS_PATH).is_ok() {
            args.push("--settingspath".to_string());
            args.push(resolve_worktree_path(worktree, DEFAULT_SETTINGS_PATH));
        } else if let Some(found) = workspace_file
            .as_deref()
            .and_then(|path| first_workspace_settings_file(worktree, path))
        {
            args.push("--settingspath".to_string());
            args.push(found);
        }

        if let Some(workspace_file) = workspace_file {
            args.push("--workspacefile".to_string());
            args.push(workspace_file);
        }

        if let Some(log_file) = setting_string(settings, &["logFile", "log_file"]) {
            args.push("--logfile".to_string());
            args.push(log_file);
        }

        if let Some(log_level) = setting_string(settings, &["logLevel", "log_level"]) {
            args.push("--loglevel".to_string());
            args.push(log_level);
        }

        args
    }

    fn resolve_env(settings: &LspSettings, worktree: &zed::Worktree) -> Vec<(String, String)> {
        let mut env = worktree.shell_env();

        if let Some(binary_env) = settings
            .binary
            .as_ref()
            .and_then(|binary| binary.env.as_ref())
        {
            for (key, value) in binary_env {
                env.retain(|(existing_key, _)| existing_key != key);
                env.push((key.clone(), value.clone()));
            }
        }

        env
    }

    fn proxy_script_path(&mut self) -> zed::Result<String> {
        if let Some(path) = &self.proxy_script_path {
            return Ok(path.clone());
        }

        let path = Self::resolve_proxy_script_path(&self.extension_work_dir)?;
        self.proxy_script_path = Some(path.clone());
        Ok(path)
    }

    fn resolve_proxy_script_path(extension_work_dir: &str) -> zed::Result<String> {
        let extension_work_dir = extension_work_dir.trim();

        if extension_work_dir.is_empty() {
            return Err(
                "Could not resolve the AL LSP proxy script path (extension work directory is unavailable). Reinstall with `zed: install dev extension`.".to_string(),
            );
        }

        let dev_script_path = join_paths(extension_work_dir, PROXY_SCRIPT_REL);
        if path_is_regular_file(&dev_script_path) {
            return Ok(dev_script_path);
        }

        let materialized_path = join_paths(extension_work_dir, PROXY_SCRIPT_NAME);
        materialize_proxy_script(&materialized_path)?;

        Ok(materialized_path)
    }

    fn background_code_analysis(settings: &LspSettings) -> BackgroundCodeAnalysis {
        let Some(value) = settings.settings.as_ref().and_then(|settings| {
            ["backgroundCodeAnalysis", "background_code_analysis"]
                .iter()
                .find_map(|key| settings.get(*key))
        }) else {
            return BackgroundCodeAnalysis::Project;
        };

        if let Some(enabled) = value.as_bool() {
            return if enabled {
                BackgroundCodeAnalysis::Project
            } else {
                BackgroundCodeAnalysis::Off
            };
        }

        match value.as_str().map(|mode| mode.trim().to_ascii_lowercase()) {
            Some(mode) if mode == "off" || mode == "none" || mode == "false" => {
                BackgroundCodeAnalysis::Off
            }
            Some(mode) if mode == "save" || mode == "file" => BackgroundCodeAnalysis::Save,
            _ => BackgroundCodeAnalysis::Project,
        }
    }
}

fn path_is_regular_file(path: &str) -> bool {
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

fn materialize_proxy_script(path: &str) -> zed::Result<()> {
    if path_is_regular_file(path) {
        let existing = std::fs::read_to_string(path)
            .map_err(|error| format!("could not read AL LSP proxy script at `{path}`: {error}"))?;

        if existing == EMBEDDED_PROXY_SCRIPT {
            return Ok(());
        }
    }

    std::fs::write(path, EMBEDDED_PROXY_SCRIPT).map_err(|error| {
        format!("could not materialize AL LSP proxy script at `{path}`: {error}")
    })
}

impl zed::Extension for AlExtension {
    fn new() -> Self {
        Self {
            extension_work_dir: std::env::var("PWD").unwrap_or_default(),
            proxy_script_path: None,
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> zed::Result<zed::Command> {
        if language_server_id.as_ref() != LANGUAGE_SERVER_ID {
            return Err(format!(
                "unsupported language server `{language_server_id}`"
            ));
        }

        let settings = Self::language_server_settings(worktree)?;
        let server_command = Self::resolve_command(&settings, worktree)?;
        let args = Self::resolve_args(&settings, worktree);
        let env = Self::resolve_env(&settings, worktree);

        // The proxy publishes diagnostics from `al compile` and fixes completion labels; both are
        // lost when it is turned off.
        if setting_bool_or(&settings, &["useProxy", "use_proxy"], true) {
            let mut proxy_args = vec![self.proxy_script_path()?];
            match Self::background_code_analysis(&settings) {
                BackgroundCodeAnalysis::Project => {}
                BackgroundCodeAnalysis::Save => proxy_args.push("--no-compile-on-open".to_string()),
                BackgroundCodeAnalysis::Off => proxy_args.push("--no-diagnostics".to_string()),
            }
            proxy_args.push("--".to_string());
            proxy_args.push(server_command);
            proxy_args.extend(args);

            return Ok(zed::Command {
                command: zed::node_binary_path()?,
                args: proxy_args,
                env,
            });
        }

        Ok(zed::Command {
            command: server_command,
            args,
            env,
        })
    }

    fn language_server_initialization_options(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> zed::Result<Option<zed::serde_json::Value>> {
        if language_server_id.as_ref() != LANGUAGE_SERVER_ID {
            return Ok(None);
        }

        Self::language_server_settings(worktree).map(|settings| settings.initialization_options)
    }

    fn run_slash_command(
        &self,
        command: zed::SlashCommand,
        args: Vec<String>,
        worktree: Option<&zed::Worktree>,
    ) -> zed::Result<zed::SlashCommandOutput> {
        if command.name.as_str() != NEXT_ID_COMMAND {
            return Err(format!("unknown slash command `{}`", command.name));
        }

        let worktree = worktree.ok_or_else(|| {
            format!("`/{NEXT_ID_COMMAND}` requires a worktree. Usage: /{NEXT_ID_COMMAND} path/to/file.al [line]")
        })?;
        let (path, line) = parse_next_id_args(&args)?;
        let source = worktree
            .read_text_file(&path)
            .map_err(|error| format!("could not read `{path}` from the worktree: {error}"))?;
        let objects = parse_al_objects(&source);

        Ok(zed::SlashCommandOutput {
            text: format_next_id_output(&path, line, &objects),
            sections: Vec::new(),
        })
    }
}

#[derive(Debug)]
struct AlObject {
    kind: String,
    id: u32,
    name: String,
    start_line: usize,
    end_line: usize,
    field_ids: Vec<u32>,
    enum_value_ids: Vec<u32>,
}

struct AlObjectDraft {
    object: AlObject,
    brace_depth: i32,
    saw_body: bool,
}

fn parse_next_id_args(args: &[String]) -> zed::Result<(String, Option<usize>)> {
    let input = args.join(" ");
    let input = input.trim();

    if input.is_empty() {
        return Err(format!("usage: /{NEXT_ID_COMMAND} path/to/file.al [line]"));
    }

    let (path, line) = if let Some((path, line)) = split_path_line(input) {
        (path, Some(line))
    } else {
        let mut parts = input.rsplitn(2, char::is_whitespace);
        let last = parts.next().unwrap_or_default();

        if let Ok(line) = last.parse::<usize>() {
            let path = parts.next().unwrap_or_default().trim();

            if path.is_empty() {
                (input, None)
            } else {
                (path, Some(line))
            }
        } else {
            (input, None)
        }
    };

    let path = path.trim().trim_matches('"').trim_matches('\'');

    if path.is_empty() {
        Err(format!("usage: /{NEXT_ID_COMMAND} path/to/file.al [line]"))
    } else {
        Ok((path.to_string(), line))
    }
}

fn split_path_line(input: &str) -> Option<(&str, usize)> {
    let (path, line) = input.rsplit_once(':')?;

    if path.len() == 1 && path.as_bytes()[0].is_ascii_alphabetic() {
        return None;
    }

    if line.is_empty() || !line.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }

    Some((path, line.parse().ok()?))
}

fn parse_al_objects(source: &str) -> Vec<AlObject> {
    let mut objects = Vec::new();
    let mut current: Option<AlObjectDraft> = None;

    for (line_index, line) in source.lines().enumerate() {
        let line_number = line_index + 1;

        if let Some(draft) = current.as_mut() {
            collect_member_ids(&mut draft.object, line);

            let delta = brace_delta(line);
            draft.brace_depth += delta;
            draft.saw_body |= line.contains('{');

            if draft.saw_body && draft.brace_depth <= 0 {
                let mut draft = current.take().expect("current object draft");
                draft.object.end_line = line_number;
                objects.push(draft.object);
            }

            continue;
        }

        let Some((kind, id, name)) = parse_object_declaration(line) else {
            continue;
        };

        let mut object = AlObject {
            kind,
            id,
            name,
            start_line: line_number,
            end_line: line_number,
            field_ids: Vec::new(),
            enum_value_ids: Vec::new(),
        };
        collect_member_ids(&mut object, line);

        let brace_depth = brace_delta(line);
        let saw_body = line.contains('{');

        if saw_body && brace_depth <= 0 {
            objects.push(object);
        } else {
            current = Some(AlObjectDraft {
                object,
                brace_depth,
                saw_body,
            });
        }
    }

    if let Some(mut draft) = current {
        draft.object.end_line = source.lines().count();
        objects.push(draft.object);
    }

    objects
}

fn parse_object_declaration(line: &str) -> Option<(String, u32, String)> {
    const OBJECT_KINDS: &[&str] = &[
        "tableextension",
        "pageextension",
        "reportextension",
        "enumextension",
        "permissionsetextension",
        "profileextension",
        "pagecustomization",
        "permissionset",
        "controladdin",
        "entitlement",
        "codeunit",
        "interface",
        "profile",
        "xmlport",
        "report",
        "query",
        "table",
        "page",
        "enum",
    ];

    let trimmed = line.trim_start();
    let lower = trimmed.to_ascii_lowercase();

    for kind in OBJECT_KINDS {
        if !lower.starts_with(kind) {
            continue;
        }

        if !trimmed
            .as_bytes()
            .get(kind.len())
            .is_some_and(|byte| byte.is_ascii_whitespace())
        {
            continue;
        }

        let rest = trimmed[kind.len()..].trim_start();
        let (id, rest) = parse_leading_number(rest)?;
        let name = parse_object_name(rest);

        return Some(((*kind).to_string(), id, name));
    }

    None
}

fn parse_object_name(rest: &str) -> String {
    let rest = rest.trim_start();

    if let Some(rest) = rest.strip_prefix('"') {
        if let Some(end_quote) = rest.find('"') {
            return rest[..end_quote].to_string();
        }
    }

    rest.split(|character: char| character.is_whitespace() || character == '{')
        .next()
        .unwrap_or_default()
        .trim_matches('"')
        .to_string()
}

fn parse_leading_number(input: &str) -> Option<(u32, &str)> {
    let end = input
        .bytes()
        .take_while(|byte| byte.is_ascii_digit())
        .count();

    if end == 0 {
        return None;
    }

    Some((input[..end].parse().ok()?, &input[end..]))
}

fn collect_member_ids(object: &mut AlObject, line: &str) {
    if let Some(id) = parse_member_id(line, "field") {
        object.field_ids.push(id);
    }

    if let Some(id) = parse_member_id(line, "value") {
        object.enum_value_ids.push(id);
    }
}

fn parse_member_id(line: &str, keyword: &str) -> Option<u32> {
    let trimmed = line.trim_start();
    let lower = trimmed.to_ascii_lowercase();

    if !lower.starts_with(keyword) {
        return None;
    }

    let rest = trimmed[keyword.len()..].trim_start();
    let rest = rest.strip_prefix('(')?.trim_start();

    parse_leading_number(rest).map(|(id, _)| id)
}

fn brace_delta(line: &str) -> i32 {
    line.chars().fold(0, |depth, character| match character {
        '{' => depth + 1,
        '}' => depth - 1,
        _ => depth,
    })
}

fn format_next_id_output(path: &str, line: Option<usize>, objects: &[AlObject]) -> String {
    if objects.is_empty() {
        return format!("No AL object declarations were found in `{path}`.");
    }

    let selected_objects: Vec<&AlObject> = if let Some(line) = line {
        objects
            .iter()
            .filter(|object| object.start_line <= line && line <= object.end_line)
            .collect()
    } else if objects.len() == 1 {
        objects.iter().collect()
    } else {
        objects.iter().collect()
    };

    if selected_objects.is_empty() {
        return format!(
            "No AL object in `{path}` contains line {}.",
            line.unwrap_or_default()
        );
    }

    let mut output = String::new();

    if let Some(line) = line {
        output.push_str(&format!("Next free AL IDs in `{path}` at line {line}:\n"));
    } else {
        output.push_str(&format!("Next free AL IDs in `{path}`:\n"));

        if objects.len() > 1 {
            output.push_str(&format!(
                "Pass a line number, for example `/{NEXT_ID_COMMAND} {path} <line>`, to target one object.\n"
            ));
        }
    }

    let next_object_id = next_free_id(
        &objects.iter().map(|object| object.id).collect::<Vec<_>>(),
        1,
    );

    for object in selected_objects {
        output.push_str(&format!(
            "- {} {} \"{}\" (lines {}-{}):",
            object.kind, object.id, object.name, object.start_line, object.end_line
        ));

        let mut parts = Vec::new();

        if !object.field_ids.is_empty() {
            parts.push(format!(
                "next field ID {}",
                next_free_id(&object.field_ids, 1)
            ));
        }

        if !object.enum_value_ids.is_empty() {
            parts.push(format!(
                "next enum value ID {}",
                next_free_id(&object.enum_value_ids, 0)
            ));
        }

        if parts.is_empty() {
            parts.push("no field or enum value IDs found".to_string());
        }

        output.push(' ');
        output.push_str(&parts.join(", "));
        output.push('\n');
    }

    output.push_str(&format!(
        "\nNext object ID in this file: {next_object_id} (file-scoped only, not project-wide)."
    ));

    output
}

fn next_free_id(ids: &[u32], default_start: u32) -> u32 {
    if ids.is_empty() {
        return default_start;
    }

    let mut sorted_ids = ids.to_vec();
    sorted_ids.sort_unstable();
    sorted_ids.dedup();

    let mut candidate = if sorted_ids.first().is_some_and(|id| *id >= 50_000) {
        sorted_ids[0]
    } else {
        default_start
    };

    for id in sorted_ids {
        if id < candidate {
            continue;
        }

        if id == candidate {
            candidate += 1;
        } else {
            break;
        }
    }

    candidate
}

fn setting_string(settings: &LspSettings, keys: &[&str]) -> Option<String> {
    let settings = settings.settings.as_ref()?;

    for key in keys {
        if let Some(value) = settings.get(*key).and_then(|value| value.as_str()) {
            if !value.trim().is_empty() {
                return Some(value.to_string());
            }
        }
    }

    None
}

fn setting_bool_or(settings: &LspSettings, keys: &[&str], default: bool) -> bool {
    settings
        .settings
        .as_ref()
        .and_then(|settings| {
            keys.iter()
                .find_map(|key| settings.get(*key).and_then(|value| value.as_bool()))
        })
        .unwrap_or(default)
}

fn setting_strings(settings: &LspSettings, keys: &[&str]) -> Vec<String> {
    let Some(settings) = settings.settings.as_ref() else {
        return Vec::new();
    };

    for key in keys {
        if let Some(value) = settings.get(*key) {
            if let Some(value) = value.as_str() {
                let value = value.trim();

                if !value.is_empty() {
                    return vec![value.to_string()];
                }
            }

            if let Some(values) = value.as_array() {
                return values
                    .iter()
                    .filter_map(|value| value.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToOwned::to_owned)
                    .collect();
            }
        }
    }

    Vec::new()
}

fn setting_path_list(settings: &LspSettings, keys: &[&str]) -> Option<String> {
    let paths = setting_strings(settings, keys);

    if paths.is_empty() {
        None
    } else {
        Some(paths.join(";"))
    }
}

/// The extension cannot list directories, so a monorepo is recognised by a `.code-workspace`
/// file at the root: a well-known name first, then `<root folder name>.code-workspace`.
fn discover_workspace_file(worktree: &zed::Worktree) -> Option<String> {
    let root = worktree.root_path();
    let root_name = root
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_string();
    let named = format!("{root_name}.code-workspace");

    WORKSPACE_FILE_CANDIDATES
        .iter()
        .map(|candidate| (*candidate).to_string())
        .chain(std::iter::once(named))
        .find(|candidate| {
            !candidate.starts_with(".code-workspace") && worktree.read_text_file(candidate).is_ok()
        })
}

/// `.vscode/settings.json` of the first folder listed in a `.code-workspace` file that has one.
/// `workspace_file` is absolute; the worktree API only reads worktree-relative paths, so the
/// file is re-read by its relative name.
fn first_workspace_settings_file(worktree: &zed::Worktree, workspace_file: &str) -> Option<String> {
    let root = worktree.root_path();
    let relative = workspace_file
        .strip_prefix(root.as_str())
        .map(|rest| rest.trim_start_matches(['/', '\\']).to_string())
        .unwrap_or_else(|| workspace_file.to_string());
    let content = worktree.read_text_file(&relative).ok()?;
    let parsed: zed::serde_json::Value = zed::serde_json::from_str(&content).ok()?;

    parsed
        .get("folders")?
        .as_array()?
        .iter()
        .filter_map(|folder| folder.get("path").and_then(|path| path.as_str()))
        .map(|folder| join_paths(folder, DEFAULT_SETTINGS_PATH))
        .find(|candidate| worktree.read_text_file(candidate).is_ok())
        .map(|candidate| resolve_worktree_path(worktree, &candidate))
}

fn resolve_worktree_path(worktree: &zed::Worktree, path: &str) -> String {
    if is_absolute_path(path) {
        path.to_string()
    } else {
        join_paths(&worktree.root_path(), path)
    }
}

fn is_absolute_path(path: &str) -> bool {
    path.starts_with('/')
        || path.starts_with('\\')
        || path
            .as_bytes()
            .get(1)
            .is_some_and(|separator| *separator == b':')
}

fn join_paths(root: &str, path: &str) -> String {
    let separator = if root.contains('\\') { "\\" } else { "/" };
    let normalized_path = path.replace(['/', '\\'], separator);

    if root.ends_with('/') || root.ends_with('\\') {
        format!("{root}{normalized_path}")
    } else {
        format!("{root}{separator}{normalized_path}")
    }
}

#[cfg(test)]
mod proxy_tests {
    use super::*;
    use std::fs;

    fn temp_work_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("zed-al-language-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp work dir should be created");
        dir
    }

    #[test]
    fn prefers_dev_scripts_path_when_present() {
        let work_dir = temp_work_dir("dev-script");
        let scripts_dir = work_dir.join("scripts");
        fs::create_dir_all(&scripts_dir).expect("scripts dir should be created");
        let dev_script = scripts_dir.join("al-lsp-proxy.js");
        fs::write(&dev_script, "dev proxy script").expect("dev script should be written");

        let resolved = AlExtension::resolve_proxy_script_path(
            &work_dir.to_string_lossy(),
        )
        .expect("dev script path should resolve");

        assert_eq!(resolved, dev_script.to_string_lossy());
    }

    #[test]
    fn materializes_proxy_script_in_fake_work_dir() {
        let work_dir = temp_work_dir("materialize");
        let expected_path = work_dir.join(PROXY_SCRIPT_NAME);

        let resolved = AlExtension::resolve_proxy_script_path(
            &work_dir.to_string_lossy(),
        )
        .expect("materialized script path should resolve");

        assert_eq!(resolved, expected_path.to_string_lossy());
        assert!(expected_path.is_file());

        let materialized = fs::read_to_string(&expected_path).expect("materialized script should be readable");
        assert_eq!(materialized, EMBEDDED_PROXY_SCRIPT);
    }

    #[test]
    fn skips_rewriting_materialized_script_when_unchanged() {
        let work_dir = temp_work_dir("unchanged");
        let script_path = work_dir.join(PROXY_SCRIPT_NAME);
        fs::write(&script_path, EMBEDDED_PROXY_SCRIPT)
            .expect("existing materialized script should be written");
        let modified = fs::metadata(&script_path)
            .expect("script metadata should exist")
            .modified()
            .expect("modified time should exist");

        materialize_proxy_script(&script_path.to_string_lossy())
            .expect("unchanged script should not be rewritten");

        assert_eq!(
            fs::metadata(&script_path)
                .expect("script metadata should still exist")
                .modified()
                .expect("modified time should still exist"),
            modified
        );
    }
}

zed::register_extension!(AlExtension);
