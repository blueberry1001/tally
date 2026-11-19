@echo off
setlocal
pushd "%~dp0"
where py >nul 2>nul
if errorlevel 1 goto usepython
py -3 wifi_view.py
goto done
:usepython
where python >nul 2>nul
if errorlevel 1 goto missing
python wifi_view.py
goto done
:missing
echo Optional Wi-Fi sharing needs Python 3.8+ on this PC.
echo For Windows-only use, just open index.html. No installation is needed.
:done
popd
pause
