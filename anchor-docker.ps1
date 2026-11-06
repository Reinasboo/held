param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$AnchorArguments
)

$ErrorActionPreference = "Stop"
$repositoryRoot = $PSScriptRoot
$image = "solanafoundation/anchor:v0.32.1@sha256:facc4ebd0738ba7ebc1eb4ef000deab6b37e7747960d3f400c73c40c5421b5de"
$keysDirectory = if ($env:HELD_SOLANA_KEYS_PATH) {
  $env:HELD_SOLANA_KEYS_PATH
} else {
  Join-Path $env:USERPROFILE ".config\solana-held"
}

docker info --format '{{.OSType}}' | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Docker Desktop is not available. Start Docker Desktop and retry."
}

if ($AnchorArguments.Count -eq 0) {
  $AnchorArguments = @("--version")
}

$dockerArguments = @(
  "run",
  "--rm",
  "--mount", "type=bind,source=$repositoryRoot,target=/workspace",
  "--workdir", "/workspace"
)

if (Test-Path -LiteralPath $keysDirectory -PathType Container) {
  $dockerArguments += @(
    "--mount", "type=bind,source=$keysDirectory,target=/keys,readonly"
  )
}

if ($AnchorArguments.Count -gt 0 -and $AnchorArguments[0] -eq "build") {
  docker @dockerArguments $image cargo build-sbf --tools-version v1.52

  if ($LASTEXITCODE -ne 0) {
    throw "SBF build failed with exit code $LASTEXITCODE."
  }

  docker @dockerArguments $image bash -lc "mkdir -p target/idl && anchor idl build --provider.cluster devnet --out target/idl/held.json"
  if ($LASTEXITCODE -ne 0) {
    throw "Anchor IDL build failed with exit code $LASTEXITCODE."
  }
} elseif ($AnchorArguments.Count -gt 0 -and $AnchorArguments[0] -eq "deploy") {
  $feePayerPath = Join-Path $keysDirectory "deployer.json"
  $programKeypairPath = Join-Path $repositoryRoot "target\deploy\held-keypair.json"
  if (-not (Test-Path -LiteralPath $feePayerPath -PathType Leaf)) {
    throw "A locally controlled fee-payer keypair is required at $feePayerPath."
  }
  if (-not (Test-Path -LiteralPath $programKeypairPath -PathType Leaf)) {
    throw "A locally controlled HELD program keypair is required at $programKeypairPath."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot "target\deploy\held.so") -PathType Leaf)) {
    throw "Build the HELD program before deploying."
  }
  $idlPath = Join-Path $repositoryRoot "target\idl\held.json"
  if (-not (Test-Path -LiteralPath $idlPath -PathType Leaf)) {
    throw "Build the HELD IDL before deploying."
  }
  $idl = Get-Content -LiteralPath $idlPath -Raw | ConvertFrom-Json
  if ($idl.address -ne "6eCgrBQEMM3oo4AgvvvXwiEkd7zFKVQF983HwpwCZLDU") {
    throw "The generated IDL does not match the configured HELD program ID."
  }

  $deployArguments = @(
    "run",
    "--rm",
    "--mount", "type=bind,source=$repositoryRoot,target=/workspace,readonly",
    "--mount", "type=bind,source=$keysDirectory,target=/keys,readonly",
    "--workdir", "/workspace"
  )
  $feePayerMount = "/keys/deployer.json"
  $programKeypairMount = "/workspace/target/deploy/held-keypair.json"
  $actualFeePayer = docker @deployArguments $image solana address -k $feePayerMount
  if ($LASTEXITCODE -ne 0) {
    throw "Could not read the public key for the configured fee payer."
  }
  if (($actualFeePayer | Out-String).Trim() -ne "FEHuZ3HFUASS2rjrcgTE6k1DSTteqKH5mXbXG3irpRDc") {
    throw "The configured fee-payer keypair does not match the approved Devnet address."
  }

  $actualProgramId = docker @deployArguments $image solana address -k $programKeypairMount
  if ($LASTEXITCODE -ne 0) {
    throw "Could not read the public key for the configured HELD program keypair."
  }
  if (($actualProgramId | Out-String).Trim() -ne "6eCgrBQEMM3oo4AgvvvXwiEkd7zFKVQF983HwpwCZLDU") {
    throw "The configured HELD program keypair does not match the approved program ID."
  }

  docker @deployArguments $image solana program deploy `
    /workspace/target/deploy/held.so `
    --url devnet `
    --keypair $feePayerMount `
    --program-id $programKeypairMount `
    --upgrade-authority $feePayerMount `
    --commitment confirmed
} else {
  docker @dockerArguments $image anchor @AnchorArguments
}

if ($LASTEXITCODE -ne 0) {
  throw "Anchor container command failed with exit code $LASTEXITCODE."
}
