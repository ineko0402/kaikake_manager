@echo off
node "%~dp0create-test-db.mjs"
if errorlevel 1 echo Test database creation failed.
pause
