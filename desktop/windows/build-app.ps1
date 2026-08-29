param(
    [ValidateSet("win-x64", "win-arm64")]
    [string]$Runtime = "win-x64",
    [Parameter(Mandatory = $true)]
    [string]$PortableGitDirectory
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
$Destination = "$Root\dist\windows\$Runtime\Hydra"

Push-Location $Root
try {
    mage build
    Remove-Item -Recurse -Force $Destination -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force "$Destination\Resources" | Out-Null

    $GoArch = if ($Runtime -eq "win-arm64") { "arm64" } else { "amd64" }
    $env:GOOS = "windows"
    $env:GOARCH = $GoArch
    go build -o "$Destination\Resources\HydraBackend.exe" .

    dotnet publish "$PSScriptRoot\HydraDesktop.csproj" `
        -c Release -r $Runtime --self-contained true `
        -p:PublishSingleFile=true `
        -o $Destination

    $GitSource = (Resolve-Path $PortableGitDirectory).Path
    Copy-Item -Recurse -Force $GitSource "$Destination\Resources\Git"
    if (-not (Test-Path "$Destination\Resources\Git\cmd\git.exe")) {
        throw "The PortableGit archive did not contain cmd\git.exe at its root."
    }
    Write-Output $Destination
}
finally {
    Pop-Location
}
