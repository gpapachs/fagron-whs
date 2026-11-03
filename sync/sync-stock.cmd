@echo off
rem Fagron WHS - stock sync (for Windows Task Scheduler)
cd /d "%~dp0"
node sync-stock.mjs %*
