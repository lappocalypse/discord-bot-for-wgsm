create a bot from discord developer portal
you have to install node.exe if you haven't it
deploy commands for your bot to use / , watch video or ask chatgpt how to make a bot
those file are only once all done
for bot to start with window use task sheduler create a new one in action search for where your start-bot.vbs are this will start the bot

to modify start-bot.vb , bot-loop.bat, config.json , status_name_ip.json
optional bot.js

after that need to modify path in start-bot.vbs , the path where folder bot-loop.bat are in and in config.json the path , the token id
the channel id , bot id , window gsm bot id , and which id self or friend are authorise to use reboot/ shutdown /stopall
all id are from discord and token where you create a bot
the bigger change are in status_name_ip.json its where are you got all server status, name, ip , pass , update are optional 
if you want your friend see the text exemple if the server auto update are on or off , save on quit are on or off , anything you want them see it 
rcon are optional too if you server use it so if you use rcon just put rconhost ip , rconport , rcon password
inside bot.js at const IGNORED_IDS = [here you can put id of server you dont want in the list of the menu];
inside status_name_ip.json just take a look once menu and 1 message are in discord to see if id are create in _meta if not you need that 
and in status_name_ip.json add as many you got server in windows gsm to match the bot menu 
  "": {
    "status": "STOPPED",
    "name": "",
    "ip": "",
    "pass": "",
    "update": "",
    "rconhost": "",
    "rconPort": "",
    "rconpass": ""
  },
after that you can manually start bot with start-bot.vbs you will see bot in discord and will auto start at boot of your pc 
just use /with the name you have create when you have deploy the menu will show in that channel 
after enjoy menu to use wgsm with dynamic message no more spam