$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$jreDirectory = Join-Path $projectRoot ".tools\temurin-jre21"
$javaExecutable = Get-ChildItem -LiteralPath $jreDirectory -Filter "java.exe" -File -Recurse |
  Where-Object { $_.Directory.Name -eq "bin" } |
  Select-Object -First 1

if (-not $javaExecutable) {
  throw "Local Java runtime was not found under .tools/temurin-jre21."
}

$env:JAVA_HOME = Split-Path -Parent $javaExecutable.Directory.FullName
$env:Path = "$($javaExecutable.Directory.FullName);$env:Path"
$env:FUNCTIONS_DISCOVERY_TIMEOUT = "30"

Push-Location $projectRoot
try {
  & firebase emulators:exec --project nekocatsmap --only firestore,functions "node --test functions/test/emulator.test.js"
  $emulatorExitCode = $LASTEXITCODE
} finally {
  Pop-Location
}

exit $emulatorExitCode
