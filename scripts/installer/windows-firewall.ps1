param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('status', 'install', 'uninstall')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$ProgramPath,

  [ValidateRange(1, 65535)]
  [int]$ProxyPort = 8888,

  [ValidateRange(1, 65535)]
  [int]$CaPort = 8889
)

$ErrorActionPreference = 'Stop'

$proxyRuleName = 'TraceLocal Proxy (Private)'
$caRuleName = 'TraceLocal CA Download (Private)'
$logPath = Join-Path (Split-Path -Parent $ProgramPath) 'tracelocal-firewall.log'

function Write-TraceLog([string]$Message) {
  try {
    Add-Content -Path $logPath -Value ("{0:o} {1}" -f [DateTime]::Now, $Message) -ErrorAction SilentlyContinue
  } catch {}
}

function Get-OwnedRule([string]$Name) {
  $rules = Get-NetFirewallRule -DisplayName $Name -PolicyStore PersistentStore -ErrorAction SilentlyContinue
  foreach ($rule in $rules) {
    $appFilter = $rule | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue
    if ($appFilter -and [string]::Equals($appFilter.Program, $ProgramPath, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $rule
    }
  }
  return $null
}

function Test-OwnedRule([string]$Name, [int]$Port) {
  $rule = Get-OwnedRule $Name
  if (-not $rule) { return $false }
  if ([string]$rule.Enabled -ne 'True' -or $rule.Direction -ne 'Inbound' -or $rule.Action -ne 'Allow') { return $false }

  $profileText = "$($rule.Profile)"
  if ($profileText -notmatch 'Private' -or $profileText -notmatch 'Public') { return $false }

  $appFilter = $rule | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue
  if (-not $appFilter -or -not [string]::Equals($appFilter.Program, $ProgramPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $false
  }

  $portFilter = $rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
  if (-not $portFilter -or "$($portFilter.Protocol)" -notmatch 'TCP') { return $false }
  if ("$($portFilter.LocalPort)" -ne "$Port") { return $false }

  $addressFilter = $rule | Get-NetFirewallAddressFilter -ErrorAction SilentlyContinue
  if (-not $addressFilter -or ("$($addressFilter.RemoteAddress)" -notmatch 'LocalSubnet')) { return $false }

  return $true
}

function Remove-OwnedRules {
  foreach ($name in @($proxyRuleName, $caRuleName)) {
    $rule = Get-OwnedRule $name
    if ($rule) {
      Remove-NetFirewallRule -Name $rule.Name -PolicyStore PersistentStore -ErrorAction Stop
    }
  }
}

function Get-ConflictingInboundBlockRules {
  $rulesKey = 'HKLM\SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\FirewallRules'
  $programNeedle = ('App=' + $ProgramPath + '|').ToLowerInvariant()
  $lines = & reg.exe query $rulesKey /f $ProgramPath /s 2>$null

  foreach ($line in $lines) {
    if ($line -notmatch '^\s*(.+?)\s+REG_SZ\s+(.+)$') { continue }

    $valueName = $matches[1].Trim()
    $value = $matches[2]
    $lower = $value.ToLowerInvariant()

    if (
      $lower.Contains('action=block|') -and
      $lower.Contains('active=true|') -and
      $lower.Contains('dir=in|') -and
      $lower.Contains($programNeedle)
    ) {
      $rule = Get-NetFirewallRule -Name $valueName -PolicyStore PersistentStore -ErrorAction SilentlyContinue
      if ($rule -and [string]$rule.Enabled -eq 'True') { $rule }
    }
  }
}

function Disable-ConflictingInboundBlockRules {
  foreach ($rule in @(Get-ConflictingInboundBlockRules)) {
    Write-TraceLog ("Disabling conflicting rule: " + $rule.Name)
    Set-NetFirewallRule -Name $rule.Name -PolicyStore PersistentStore -Enabled False -ErrorAction Stop

    $updated = Get-NetFirewallRule -Name $rule.Name -PolicyStore PersistentStore -ErrorAction Stop
    if ([string]$updated.Enabled -ne 'False') {
      throw "Failed to disable conflicting firewall rule: $($rule.Name)"
    }
  }
}

try {
  Write-TraceLog ("Action=$Action ProgramPath=$ProgramPath ProxyPort=$ProxyPort CaPort=$CaPort")

  switch ($Action) {
    'status' {
      $hasConflictingBlockRule = @(Get-ConflictingInboundBlockRules).Count -gt 0
      if (
        -not $hasConflictingBlockRule -and
        (Test-OwnedRule $proxyRuleName $ProxyPort) -and
        (Test-OwnedRule $caRuleName $CaPort)
      ) {
        exit 0
      }
      exit 2
    }

    'install' {
      Write-TraceLog 'Starting firewall repair'

      Remove-OwnedRules
      Disable-ConflictingInboundBlockRules

      $proxyParams = @{
        DisplayName = $proxyRuleName
        Direction = 'Inbound'
        Action = 'Allow'
        Enabled = 'True'
        Profile = 'Private, Public'
        Program = $ProgramPath
        Protocol = 'TCP'
        LocalPort = $ProxyPort
        RemoteAddress = 'LocalSubnet'
        PolicyStore = 'PersistentStore'
      }
      New-NetFirewallRule @proxyParams | Out-Null

      $caParams = @{
        DisplayName = $caRuleName
        Direction = 'Inbound'
        Action = 'Allow'
        Enabled = 'True'
        Profile = 'Private, Public'
        Program = $ProgramPath
        Protocol = 'TCP'
        LocalPort = $CaPort
        RemoteAddress = 'LocalSubnet'
        PolicyStore = 'PersistentStore'
      }
      New-NetFirewallRule @caParams | Out-Null

      if (@(Get-ConflictingInboundBlockRules).Count -gt 0) {
        throw 'Conflicting inbound block rules are still enabled after repair.'
      }
      if (-not (Test-OwnedRule $proxyRuleName $ProxyPort)) {
        throw 'Proxy firewall rule could not be verified after repair.'
      }
      if (-not (Test-OwnedRule $caRuleName $CaPort)) {
        throw 'CA download firewall rule could not be verified after repair.'
      }

      Write-TraceLog 'Firewall repair completed successfully'
      exit 0
    }

    'uninstall' {
      Remove-OwnedRules
      exit 0
    }
  }
} catch {
  Write-TraceLog ("ERROR: " + $_.Exception.Message)
  Write-Error $_
  exit 1
}
