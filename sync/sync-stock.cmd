@echo off
rem Fagron WHS - stock sync (Windows PowerShell, no install needed)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync-stock.ps1" %*
