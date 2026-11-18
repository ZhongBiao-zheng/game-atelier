# Windows desktop CI: the installer, the installed app, its uninstaller and the
# "Settings > Apps" entry must all show the Atelier icon (docs/contracts/desktop-shell.md).
# Saves what Explorer would draw for each file into the output folder and fails when any of
# them differs from the app's own icon (the stock NSIS icon would).
param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [Parameter(Mandatory = $true)][string]$Output
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ShellIcon {
    [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItemImageFactory { void GetImage(SIZE size, int flags, out IntPtr bitmap); }
    [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx; public int cy; }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr bc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItemImageFactory item);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr handle);
    // SIIGBF_ICONONLY: the file's icon as Explorer draws it, never a thumbnail. The caller frees it.
    public static IntPtr Get(string path, int size) {
        IShellItemImageFactory factory;
        SHCreateItemFromParsingName(path, IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out factory);
        IntPtr handle;
        factory.GetImage(new SIZE { cx = size, cy = size }, 0x4, out handle);
        return handle;
    }
}
'@

function Save-Icons([string]$Path, [string]$Name) {
    foreach ($size in 16, 32, 256) {
        $handle = [ShellIcon]::Get($Path, $size)
        $bitmap = [System.Drawing.Image]::FromHbitmap($handle)
        [ShellIcon]::DeleteObject($handle) | Out-Null
        $bitmap.Save((Join-Path $Output "icon-$Name-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        $bitmap.Dispose()
    }
}

function Get-Pixels([string]$Path) {
    $bitmap = [System.Drawing.Icon]::ExtractAssociatedIcon($Path).ToBitmap()
    $pixels = for ($y = 0; $y -lt $bitmap.Height; $y++) {
        for ($x = 0; $x -lt $bitmap.Width; $x++) { $bitmap.GetPixel($x, $y).ToArgb() }
    }
    $bitmap.Dispose()
    return ($pixels -join ',')
}

New-Item -ItemType Directory -Force -Path $Output | Out-Null
$installer = (Resolve-Path $Installer).Path
$work = Join-Path ([System.IO.Path]::GetTempPath()) "atelier-icon-$PID"
Start-Process -FilePath $installer -ArgumentList '--silent', '--dir', "`"$work`"" -Wait
$app = Get-ChildItem $work -Filter '*.exe' | Where-Object { $_.Name -ne 'uninstall.exe' } | Select-Object -First 1
$uninstaller = Join-Path $work 'uninstall.exe'
$entry = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' |
    Where-Object { (Get-ItemProperty $_.PSPath).UninstallString -like "*$work*" } | Select-Object -First 1
$displayIcon = if ($entry) { (Get-ItemProperty $entry.PSPath).DisplayIcon.Trim('"') } else { '' }

$problems = @()
$expected = Get-Pixels $app.FullName
foreach ($file in @(
        @{ Name = 'setup'; Path = $installer },
        @{ Name = 'app'; Path = $app.FullName },
        @{ Name = 'uninstall'; Path = $uninstaller })) {
    Save-Icons $file.Path $file.Name
    if ((Get-Pixels $file.Path) -ne $expected) { $problems += "$($file.Name) does not carry the app icon" }
}
# Compare resolved paths: the temp folder may come back in its 8.3 form.
if (-not $displayIcon -or -not (Test-Path $displayIcon) -or (Get-Item $displayIcon).FullName -ne $app.FullName) {
    $problems += "Settings > Apps entry points at '$displayIcon'"
}

# The uninstaller copies itself to %TEMP% and returns at once; wait for it to finish so the
# next install does not race it for the same uninstall key.
Start-Process -FilePath $uninstaller -ArgumentList '--silent' -Wait
$deadline = (Get-Date).AddSeconds(120)
while ((Test-Path $work) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
if (Test-Path $work) { $problems += 'uninstall left the install folder' }
if ($problems) { throw "icon check failed: $($problems -join '; ')" }
Write-Output "icon check passed: setup, app, uninstaller and the Apps entry share the app icon"
