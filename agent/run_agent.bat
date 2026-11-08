@echo off
REM Start the D801 encoder agent with 32-bit Python (py launcher).
cd /d "%~dp0"
py -3-32 agent.py --config agent.json %*
