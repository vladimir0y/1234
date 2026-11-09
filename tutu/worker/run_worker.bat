@echo off
rem Tutu worker for Windows. Fill in the two lines below, then double-click this file.
set TUTU_SERVER=https://tutu-xxxx.onrender.com
set TUTU_TOKEN=paste-the-same-token-as-on-render
rem Forge address (default port 7860).
set FORGE_URL=http://127.0.0.1:7860
rem Sampling for SDXL Lightning / Hyper models. For a regular SDXL model use 28 steps and CFG 6.
set TUTU_STEPS=8
set TUTU_CFG=2
python "%~dp0tutu_worker.py"
pause
