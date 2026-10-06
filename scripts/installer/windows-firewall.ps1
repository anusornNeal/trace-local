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

function Get-OwnedRule([string]$Name) {
  Get-NetFirewallRule -DisplayName $Name -PolicyStore ActiveStore -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

function Test-OwnedRule([string]$Name, [int]$Port) {
  $rule = Get-OwnedRule $Name
  if (-not $rule) { return $false }
  if (-not $rule.Enabled -or $rule.Direction -ne 'Inbound' -or $rule.Action -ne 'Allow') { return $false }
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
    Get-NetFirewallRule -DisplayName $name -PolicyStore ActiveStore -ErrorAction SilentlyContinue |
      Remove-NetFirewallRule -ErrorAction SilentlyContinue
  }
}

function Remove-ConflictingInboundBlockRules {
  $filters = Get-NetFirewallApplicationFilter -PolicyStore ActiveStore -ErrorAction SilentlyContinue |
    Where-Object { [string]::Equals($_.Program, $ProgramPath, [System.StringComparison]::OrdinalIgnoreCase) }

  foreach ($filter in $filters) {
    Get-NetFirewallRule -AssociatedNetFirewallApplicationFilter $filter -ErrorAction SilentlyContinue |
      Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } |
      Remove-NetFirewallRule -ErrorAction SilentlyContinue
  }
}

switch ($Action) {
  'status' {
    if ((Test-OwnedRule $proxyRuleName $ProxyPort) -and (Test-OwnedRule $caRuleName $CaPort)) {
      exit 0
    }
    exit 2
  }

  'install' {
    Remove-OwnedRules
    Remove-ConflictingInboundBlockRules

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
    }
    New-NetFirewallRule @caParams | Out-Null

    exit 0
  }

  'uninstall' {
    Remove-OwnedRules
    exit 0
  }
}
