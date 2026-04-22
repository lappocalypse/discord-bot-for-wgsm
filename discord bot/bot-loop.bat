@echo off
set BOT_DIR=C:\your path where the folder bot.js are in
set LOG_FILE=%BOT_DIR%\bot-log.txt

:loop
cd /d %BOT_DIR%
echo [%date% %time%] Démarrage du bot... >> %LOG_FILE%
node bot.js >> %LOG_FILE% 2>&1
echo [%date% %time%] Bot arrêté, redémarrage dans 5 secondes... >> %LOG_FILE%
timeout /t 5 /nobreak >nul
goto loop