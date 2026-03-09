param(
  [string]$Version = "latest",
  [string]$Prefix = "",
  [string]$PackageName = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$envPackageName = $env:PM_CLI_PACKAGE
if ([string]::IsNullOrWhiteSpace($PackageName)) {
  if ([string]::IsNullOrWhiteSpace($envPackageName)) {
    $PackageName = "@unbrained/pm-cli"
  } else {
    $PackageName = $envPackageName
  }
}

function Require-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

function Use-LiteralInstallSpec {
  param([string]$Name)

  if ([string]::IsNullOrWhiteSpace($Name)) {
    return $false
  }

  if ($Name -match "^(file:|https?://|git\+|npm:)") {
    return $true
  }

  if ($Name.StartsWith("./") -or $Name.StartsWith("../") -or $Name.StartsWith("/") -or $Name.StartsWith("~/")) {
    return $true
  }

  if ($Name.Contains('\') -or $Name -match "^[A-Za-z]:[\\/]") {
    return $true
  }

  if ($Name.EndsWith(".tgz") -or $Name.EndsWith(".tar.gz")) {
    return $true
  }

  if ($Name.StartsWith("@")) {
    return $Name -match "^@[^/]+/[^@]+@.+$"
  }

  return $Name.Contains("@")
}

Require-Command "node"
Require-Command "npm"

$installSpec = $null
if (Use-LiteralInstallSpec $PackageName) {
  $installSpec = $PackageName
} else {
  $installSpec = "$PackageName@$Version"
}
Write-Host "Installing or updating $installSpec..."
$npmArgs = @("install", "-g", $installSpec)
if ($Prefix -ne "") {
  $npmArgs += @("--prefix", $Prefix)
}

& npm @npmArgs
if ($LASTEXITCODE -ne 0) {
  throw "npm install failed with exit code $LASTEXITCODE"
}

$pmCommand = Get-Command "pm" -ErrorAction SilentlyContinue
if ($pmCommand) {
  $pmExecutable = $pmCommand.Source
} else {
  $candidates = @()
  if ($Prefix -ne "") {
    $candidates += (Join-Path $Prefix "pm.cmd")
    $candidates += (Join-Path $Prefix "bin/pm.cmd")
    $candidates += (Join-Path $Prefix "pm")
    $candidates += (Join-Path $Prefix "bin/pm")
  }

  $resolved = $null
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      $resolved = $candidate
      break
    }
  }

  if (-not $resolved) {
    $hint = ""
    if ($Prefix -ne "") {
      $hint = " Add '$Prefix' (or '$Prefix\bin') to PATH and retry."
    }
    throw "pm binary not found after install.$hint"
  }
  $pmExecutable = $resolved
}

$versionOutput = & $pmExecutable --version
if ($LASTEXITCODE -ne 0) {
  throw "pm --version failed with exit code $LASTEXITCODE"
}

Write-Host "Installed pm version: $versionOutput"
Write-Host "Done."
