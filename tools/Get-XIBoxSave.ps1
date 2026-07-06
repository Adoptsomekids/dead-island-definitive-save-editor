#!/usr/bin/env pwsh
# Get-XIBoxSave.ps1
# Dead Island Definitive Edition — Xbox Series X Save Downloader
# Runs on Windows (requires Xbox app / Gaming Services installed)
# Downloads save atoms from Xbox Live Connected Storage to local files.
#
# Usage:
#   .\Get-XIBoxSave.ps1 -OutDir .\saves
#   .\Get-XIBoxSave.ps1 -OutDir .\saves -Guid "972875C7-F554-4CBB-855D-1D2BFAA706F0" -Size 1785

param(
    [string]$OutDir  = ".\saves",
    [string]$Xuid    = "2535409375459619",
    [string]$Scid    = "db860100-d780-4e17-8685-ad130052ea64",
    [string]$Pfn     = "DeepSilver.DeadIslandDefinitiveEdition_hmv7qcest37me",
    [string]$Guid    = "",
    [int]   $Size    = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Constants ──────────────────────────────────────────────────────────────────

$CLIENT_ID     = "b1eab458-325b-45a5-9692-ad6079c1eca8"
$MSA_TENANT    = "consumers"
$MSA_SCOPES    = "Xboxlive.signin Xboxlive.offline_access offline_access"
$TS_BASE       = "https://titlestorage.xboxlive.com"
$CACHE_FILE    = "$env:USERPROFILE\.xbox-savebridge-tokens.json"

# All known atom manifests for Adopted Kz's DI DE saves
$ATOMS = @(
    @{ Name="PROFILE_DATA"; Guid="BDE638D4-8379-4867-A706-4E05EEAA0CBD"; Size=2304 },
    @{ Name="save_0.sav";   Guid="807F953E-558B-4281-A5A6-278E83A725CF"; Size=837  },
    @{ Name="save_1.sav";   Guid="972875C7-F554-4CBB-855D-1D2BFAA706F0"; Size=1785 },
    @{ Name="save_2.sav";   Guid="DF0878BC-275C-41AD-AE76-85B642308BFF"; Size=854  }
)

# ── Auth helpers ───────────────────────────────────────────────────────────────

function Get-TokenCache {
    if (Test-Path $CACHE_FILE) {
        return Get-Content $CACHE_FILE | ConvertFrom-Json
    }
    return @{}
}

function Save-TokenCache($cache) {
    $cache | ConvertTo-Json | Set-Content $CACHE_FILE
}

function Invoke-MsaRefresh($refreshToken) {
    $body = "client_id=$CLIENT_ID&grant_type=refresh_token&refresh_token=$refreshToken&scope=$MSA_SCOPES"
    $r    = Invoke-RestMethod "https://login.microsoftonline.com/$MSA_TENANT/oauth2/v2.0/token" `
                -Method POST -Body $body -ContentType "application/x-www-form-urlencoded"
    return $r
}

function Invoke-XasuToken($msaToken) {
    $body = @{
        Properties = @{
            AuthMethod  = "RPS"
            SiteName    = "user.auth.xboxlive.com"
            RpsTicket   = "d=$msaToken"
        }
        RelyingParty = "http://auth.xboxlive.com"
        TokenType    = "JWT"
    } | ConvertTo-Json -Depth 5
    $r = Invoke-RestMethod "https://user.auth.xboxlive.com/user/authenticate" `
                -Method POST -Body $body -ContentType "application/json"
    return $r.Token
}

function Invoke-XstsToken($xasuToken) {
    $body = @{
        Properties = @{
            SandboxId  = "RETAIL"
            UserTokens = @($xasuToken)
        }
        RelyingParty = "http://xboxlive.com"
        TokenType    = "JWT"
    } | ConvertTo-Json -Depth 5
    $r = Invoke-RestMethod "https://xsts.auth.xboxlive.com/xsts/authorize" `
                -Method POST -Body $body -ContentType "application/json"
    return $r
}

function Get-AuthHeader {
    $cache = Get-TokenCache
    $now   = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

    if ($cache.xstsToken -and $cache.xstsExpiry -and $cache.xstsExpiry -gt ($now + 300000)) {
        return "XBL3.0 x=$($cache.userHash);$($cache.xstsToken)"
    }

    if (-not $cache.msaRefreshToken) {
        Write-Error "No Xbox Live token cached. Run 'npx ts-node tools/save-sync.ts --login' on your Mac first, then copy $CACHE_FILE here."
    }

    Write-Host "Refreshing MSA token..." -NoNewline
    $msa = Invoke-MsaRefresh $cache.msaRefreshToken
    Write-Host " OK"

    Write-Host "Getting XSTS..." -NoNewline
    $xasu = Invoke-XasuToken $msa.access_token
    $xsts = Invoke-XstsToken $xasu
    $xui  = $xsts.DisplayClaims.xui[0]
    $exp  = [DateTimeOffset]::Parse($xsts.NotAfter).ToUnixTimeMilliseconds()
    Write-Host " OK"

    $cache | Add-Member -NotePropertyName msaAccessToken  -NotePropertyValue $msa.access_token  -Force
    $cache | Add-Member -NotePropertyName msaRefreshToken -NotePropertyValue $msa.refresh_token  -Force
    $cache | Add-Member -NotePropertyName msaExpiry       -NotePropertyValue ([long]($now + $msa.expires_in * 1000)) -Force
    $cache | Add-Member -NotePropertyName xstsToken       -NotePropertyValue $xsts.Token         -Force
    $cache | Add-Member -NotePropertyName xstsExpiry      -NotePropertyValue $exp                -Force
    $cache | Add-Member -NotePropertyName userHash        -NotePropertyValue $xui.uhs            -Force
    $cache | Add-Member -NotePropertyName xuid            -NotePropertyValue $xui.xid            -Force
    $cache | Add-Member -NotePropertyName gamertag        -NotePropertyValue $xui.gtg            -Force
    Save-TokenCache $cache

    return "XBL3.0 x=$($xui.uhs);$($xsts.Token)"
}

# ── Download helpers ───────────────────────────────────────────────────────────

function Get-AtomSasUrl($auth, $xuid, $scid, $atomGuid, $atomSize, $pfn) {
    $url     = "$TS_BASE/connectedstorage/users/xuid($xuid)/scids/$scid/atoms/$([Uri]::EscapeDataString("$atomGuid,binary"))"
    $headers = @{
        Authorization          = $auth
        "x-xbl-contract-version" = "107"
        "x-xbl-pfn"            = $pfn
    }
    try {
        $r = Invoke-RestMethod $url -Method POST -Headers $headers `
                -Body "{`"size`": $atomSize}" -ContentType "application/json"
        return $r.blobUri
    } catch {
        # May fail without device token — return $null
        Write-Warning "atoms POST failed: $($_.Exception.Message)"
        return $null
    }
}

function Get-AtomDirect($auth, $xuid, $scid, $atomGuid, $pfn) {
    # Attempt GET on atom path (requires device+title token — may fail)
    $url     = "$TS_BASE/connectedstorage/users/xuid($xuid)/scids/$scid/atoms/$([Uri]::EscapeDataString("$atomGuid,binary"))"
    $headers = @{
        Authorization          = $auth
        "x-xbl-contract-version" = "107"
        "x-xbl-pfn"            = $pfn
    }
    try {
        $bytes = Invoke-RestMethod $url -Method GET -Headers $headers
        return $bytes
    } catch {
        return $null
    }
}

# ── Main ───────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "Dead Island DE — Xbox Save Downloader"
Write-Host ("─" * 45)
Write-Host "SCID : $Scid"
Write-Host "PFN  : $Pfn"
Write-Host ""

$auth = Get-AuthHeader
Write-Host "✔ Authenticated as: $(Get-TokenCache | Select-Object -ExpandProperty gamertag) (XUID: $Xuid)"
Write-Host ""

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

# If a specific GUID was passed, just download that one
$atomList = if ($Guid) { @(@{Name="custom"; Guid=$Guid; Size=$Size}) } else { $ATOMS }

$downloaded = 0
foreach ($atom in $atomList) {
    Write-Host "  Downloading $($atom.Name) ($($atom.Guid.Substring(0,8))..., $($atom.Size) bytes)..." -NoNewline

    # Try SAS URL approach first
    $sasUrl = Get-AtomSasUrl $auth $Xuid $Scid $atom.Guid $atom.Size $Pfn
    if ($sasUrl) {
        try {
            $outFile = Join-Path $OutDir "$($atom.Name).bin"
            Invoke-WebRequest $sasUrl -OutFile $outFile -UseBasicParsing
            $sz = (Get-Item $outFile).Length
            Write-Host " ✔ ($sz bytes) → $outFile"
            $downloaded++
            continue
        } catch {
            Write-Host " SAS download failed: $($_.Exception.Message)"
        }
    }

    # Try direct GET (may work with device token)
    $data = Get-AtomDirect $auth $Xuid $Scid $atom.Guid $Pfn
    if ($data) {
        $outFile = Join-Path $OutDir "$($atom.Name).bin"
        [IO.File]::WriteAllBytes($outFile, $data)
        Write-Host " ✔ ($(($data).Length) bytes) → $outFile"
        $downloaded++
    } else {
        Write-Host " ✗ Failed — needs device+title token (Gaming Services)"
        Write-Host "    Try installing xbcsmgr and using that to download the save"
    }
}

Write-Host ""
if ($downloaded -gt 0) {
    Write-Host "✔ Downloaded $downloaded save(s) to $OutDir"
    Write-Host ""
    Write-Host "Copy these .bin files to your Mac and run:"
    Write-Host "  npx ts-node tools/save-sync.ts --info --input <file>.bin"
    Write-Host "  npx ts-node src/cli.ts --input <file>.bin --god-mode"
} else {
    Write-Host "✗ No saves downloaded."
    Write-Host "  The /atoms/ endpoint requires Gaming Services device token."
    Write-Host "  Try installing xbcsmgr.exe and running it with your Xbox account."
    Write-Host "  Download: https://github.com/XboxChaos/xbcsmgr"
}
