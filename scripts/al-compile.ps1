<#
.SYNOPSIS
    Compiles the AL project that contains a file, the way VS Code's "AL: Package" does.

.DESCRIPTION
    Walks up from -Path until it finds app.json, reads .vscode/settings.json of that project
    (al.codeAnalyzers, al.ruleSetPath, al.packageCachePath, al.assemblyProbingPaths) and runs
    `al compile` from the Microsoft.Dynamics.BusinessCentral.Development.Tools dotnet tool.
    Diagnostics are printed as `file:line:col: severity CODE: message`, which Zed's terminal
    turns into clickable links. Meant to be run from a Zed task with $ZED_FILE.

.PARAMETER Path
    A file inside the project (typically $ZED_FILE) or the project folder itself.

.PARAMETER NoAnalyzers
    Skip the code analyzers and the ruleset; compiler diagnostics only.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $Path,
    [switch] $NoAnalyzers
)

$ErrorActionPreference = 'Stop'
$ToolPackage = 'microsoft.dynamics.businesscentral.development.tools'
$AnalyzerDlls = @{
    CodeCop               = 'Microsoft.Dynamics.Nav.CodeCop.dll'
    UICop                 = 'Microsoft.Dynamics.Nav.UICop.dll'
    AppSourceCop          = 'Microsoft.Dynamics.Nav.AppSourceCop.dll'
    PerTenantExtensionCop = 'Microsoft.Dynamics.Nav.PerTenantExtensionCop.dll'
}

function Find-ProjectRoot([string] $Start) {
    $dir = if (Test-Path -LiteralPath $Start -PathType Container) { $Start } else { Split-Path -Parent $Start }
    while ($dir) {
        if (Test-Path -LiteralPath (Join-Path $dir 'app.json')) { return $dir }
        $parent = Split-Path -Parent $dir
        if (-not $parent -or $parent -eq $dir) { break }
        $dir = $parent
    }
    return $null
}

function Find-AlTool {
    $cmd = Get-Command al -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidate = Join-Path $HOME '.dotnet/tools/al.exe'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
    $candidate = Join-Path $HOME '.dotnet/tools/al'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
    return $null
}

# Analyzer DLLs ship in the tool store next to the compiler. Only the net8.0 build reports diagnostics.
function Find-AnalyzerDir([string] $AlExe) {
    $store = Join-Path (Split-Path -Parent $AlExe) ".store/$ToolPackage"
    if (-not (Test-Path -LiteralPath $store)) { return $null }
    $versions = Get-ChildItem -LiteralPath $store -Directory | Sort-Object { [version]($_.Name -replace '[^0-9.].*$', '') } -Descending
    foreach ($v in $versions) {
        $dir = Join-Path $v.FullName "$ToolPackage/$($v.Name)/tools/net8.0/any"
        if (Test-Path -LiteralPath (Join-Path $dir $AnalyzerDlls.CodeCop)) { return $dir }
    }
    return $null
}

function Read-Jsonc([string] $File) {
    if (-not (Test-Path -LiteralPath $File)) { return $null }
    $text = Get-Content -LiteralPath $File -Raw
    $text = [regex]::Replace($text, '(?m)^\s*//.*$', '')
    $text = [regex]::Replace($text, '(?s)/\*.*?\*/', '')
    $text = [regex]::Replace($text, ',(\s*[}\]])', '$1')
    return $text | ConvertFrom-Json
}

function Resolve-Against([string] $Root, [string] $Rel) {
    if ([System.IO.Path]::IsPathRooted($Rel)) { return $Rel }
    return Join-Path $Root $Rel
}

$root = Find-ProjectRoot $Path
if (-not $root) { Write-Error "No app.json found above $Path"; exit 2 }
$manifest = Get-Content -LiteralPath (Join-Path $root 'app.json') -Raw | ConvertFrom-Json
$al = Find-AlTool
if (-not $al) { Write-Error "'al' tool not found. Install it: dotnet tool install --global Microsoft.Dynamics.BusinessCentral.Development.Tools"; exit 2 }

$settings = Read-Jsonc (Join-Path $root '.vscode/settings.json')
$caches = @($settings.'al.packageCachePath' | Where-Object { $_ })
if ($caches.Count -eq 0) { $caches = @('.alpackages') }
$errorLog = Join-Path ([System.IO.Path]::GetTempPath()) ("al-compile-{0}.json" -f [guid]::NewGuid().ToString('N'))

$args = @('compile', "/project:$root", '/parallel', "/errorlog:$errorLog",
          "/packagecachepath:$(($caches | ForEach-Object { Resolve-Against $root $_ }) -join ',')")
$probing = @($settings.'al.assemblyProbingPaths' | Where-Object { $_ })
if ($probing.Count -gt 0) { $args += "/assemblyprobingpaths:$(($probing | ForEach-Object { Resolve-Against $root $_ }) -join ',')" }

$applied = @()
if (-not $NoAnalyzers) {
    if ($settings.'al.ruleSetPath') {
        $args += "/ruleset:$(Resolve-Against $root $settings.'al.ruleSetPath')"
        $applied += "ruleset $(Split-Path -Leaf $settings.'al.ruleSetPath')"
    }
    $analyzerDir = Find-AnalyzerDir $al
    foreach ($entry in @($settings.'al.codeAnalyzers' | Where-Object { $_ })) {
        $dll = $null
        if ($entry -match '^\$\{(\w+)\}(.*)$') {
            if (-not $analyzerDir) { Write-Warning "analyzer $entry skipped: analyzer folder not found in the al tool store"; continue }
            if ($Matches[1] -eq 'analyzerFolder') { $dll = Join-Path $analyzerDir ($Matches[2].TrimStart('\', '/')) }
            elseif ($AnalyzerDlls.ContainsKey($Matches[1])) { $dll = Join-Path $analyzerDir $AnalyzerDlls[$Matches[1]] }
            else { Write-Warning "unknown analyzer token $entry skipped"; continue }
        } else {
            $dll = Resolve-Against $root $entry
        }
        if (Test-Path -LiteralPath $dll) { $args += "/analyzer:$dll"; $applied += (Split-Path -Leaf $dll) -replace '^Microsoft\.Dynamics\.Nav\.|\.dll$', '' }
        else { Write-Warning "analyzer not found, skipped: $dll" }
    }
}

Write-Host "AL: compiling $($manifest.name) ($root)"
Write-Host ("    " + $(if ($applied.Count) { $applied -join ', ' } else { 'no analyzers' }))
$sw = [Diagnostics.Stopwatch]::StartNew()
$output = & $al @args 2>&1
$exit = $LASTEXITCODE
$sw.Stop()

$issues = @()
if (Test-Path -LiteralPath $errorLog) {
    $log = Get-Content -LiteralPath $errorLog -Raw | ConvertFrom-Json
    $issues = @($log.issues)
    Remove-Item -LiteralPath $errorLog -Force -ErrorAction SilentlyContinue
}

$order = @{ Error = 0; Warning = 1; Info = 2; Hidden = 3 }
$sorted = $issues | Sort-Object { $order[$_.properties.severity] }, { $_.locations[0].analysisTarget[0].uri }, { $_.locations[0].analysisTarget[0].region.startLine }
foreach ($i in $sorted) {
    $t = $i.locations[0].analysisTarget[0]
    $file = $t.uri -replace '^file:///', '' -replace '/', '\'
    $sev = $i.properties.severity.ToLower()
    $line = "{0}:{1}:{2}: {3} {4}: {5}" -f $file, $t.region.startLine, $t.region.startColumn, $sev, $i.ruleId, $i.shortMessage
    if ($sev -eq 'error') { Write-Host $line -ForegroundColor Red } elseif ($sev -eq 'warning') { Write-Host $line -ForegroundColor Yellow } else { Write-Host $line }
}
if ($issues.Count -eq 0 -and $exit -ne 0) { $output | ForEach-Object { Write-Host $_ } }

$errors = @($issues | Where-Object { $_.properties.severity -eq 'Error' }).Count
$warnings = @($issues | Where-Object { $_.properties.severity -eq 'Warning' }).Count
$summary = "{0} error(s), {1} warning(s), {2:n1}s" -f $errors, $warnings, $sw.Elapsed.TotalSeconds
if ($exit -eq 0) { Write-Host "AL: build succeeded — $summary" -ForegroundColor Green } else { Write-Host "AL: build FAILED (exit $exit) — $summary" -ForegroundColor Red }
exit $exit
