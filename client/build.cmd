@echo off
rem Builds NodeSafeRDP.exe with the C# compiler that ships with Windows (.NET Framework 4.x).
rem No administrator rights, no Visual Studio, no SDK and no downloads are needed.
rem Because the exe is compiled locally it carries no "downloaded from the internet" mark,
rem so SmartScreen does not ask for a publisher certificate.
setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo .NET Framework 4 C# compiler not found. Use run.ps1 instead.
  exit /b 1
)
cd /d "%~dp0"
"%CSC%" /nologo /optimize+ /target:exe /platform:anycpu /out:NodeSafeRDP.exe ^
  /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll ^
  /r:System.Web.Extensions.dll /r:System.Security.dll ^
  NodeSafeRDP.cs
if errorlevel 1 (
  echo Build failed.
  exit /b 1
)
echo.
echo Built %~dp0NodeSafeRDP.exe
echo First run:  NodeSafeRDP.exe --setup --server https://YOUR-SERVER --key YOUR-AGENT-KEY
echo Then:       NodeSafeRDP.exe
