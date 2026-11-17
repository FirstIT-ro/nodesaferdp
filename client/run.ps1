<#
  Runs the NodeSafeRDP agent straight from source, without creating an .exe.
  Works for a standard (non-administrator) user. Start it with:

    powershell -ExecutionPolicy Bypass -File .\run.ps1 --setup --server https://YOUR-SERVER --key YOUR-AGENT-KEY
    powershell -ExecutionPolicy Bypass -File .\run.ps1

  "-ExecutionPolicy Bypass" only applies to this one PowerShell process and needs no admin rights.
  (It does not work if your organisation enforces Constrained Language Mode / AppLocker;
   then use build.cmd, or ask IT.)
#>
$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot 'NodeSafeRDP.cs'

if (-not ('NodeSafeRDP.Program' -as [type])) {
    Add-Type -TypeDefinition (Get-Content -Raw -Path $src) -Language CSharp -ReferencedAssemblies @(
        'System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll',
        'System.Web.Extensions.dll', 'System.Security.dll'
    )
}

# Used if you pass "--autostart on": start this script hidden-minimised at logon.
$env:NSR_LAUNCH_COMMAND = "powershell.exe -NoProfile -WindowStyle Minimized -ExecutionPolicy Bypass -File `"$PSCommandPath`""

$code = [NodeSafeRDP.Program]::Main([string[]]$args)
exit $code
