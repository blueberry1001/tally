@echo off
setlocal
pushd "%~dp0"
where py >nul 2>nul
if errorlevel 1 goto usepython
py -3 -B tally_db.py %*
goto done
:usepython
where python >nul 2>nul
if errorlevel 1 goto missing
python -B tally_db.py %*
goto done
:missing
echo Optional SQLite mode needs Python 3.8+ with sqlite3 on this PC.
echo For the browser-only edition, open index.html instead.
:done
popd
pause
