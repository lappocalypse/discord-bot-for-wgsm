create a bot from discord developer portal
you have to install node.exe if you haven't it
deploy commands for your bot to use / , watch video or ask chatgpt how to make a bot
those file are only once all done
for bot to start with window use task sheduler create a new one in action search for where your start-bot.vbs are this will start the bot

to modify start-bot.vb , bot-loop.bat, config.json , status_name_ip.json mandatory

start-bot.vbs - modify the path where folder bot-loop.bat WshShell.Run "C:\folder\bot-loop.bat"

bot-loop.bat - set BOT_DIR="C:\folder , is the folder where bot.js are in

config.json - the path "C:\\folder" , the token id , the channel id , bot id , window gsm bot id , whitelist empty for all are                   authorise to use menu or put id of authorise self/friend to use the menu 
              power is for whitelist who can use reboot pc/shutdown pc and stopall server at once and blacklist empty or any id                  you want to not use the menu exemple ["id","id"]
              all id are from discord and token are from when you create a bot


status_name_ip.json - the bigger change are here its where are you got all server status, name of server, ip that your friend use, pass in game , update are optional 
                      if you want your friend see the text - exemple if the server have auto update are on or off , save on quit are on or off , anything you want them to see 
                      rcon are optional too if you server use it so if you use rcon just put rconhost ip , rconport , rcon password but for now rcon only sent message saveworld so it made for atk asa
                      
inside bot.js - at const IGNORED_IDS = [here you can put id of server you dont want in the list of the menu];

inside status_name_ip.json just take a look once menu and 1 message are in discord to see if id are create in _meta if not you need that 
and in status_name_ip.json add as many you got server in windows gsm to match the bot menu 
this is add more               this is exemple
  "": {                         "1": {
    "status": "STOPPED",          "status": "STOPPED",
    "name": "",                   "name": "ark",
    "ip": "",                     "ip": "xxx.xxx.xx.x",
    "pass": "",                   "pass": "pasdword",
    "update": "",                 "update": ""
    "rconhost": "",               "rconhost": "ip",
    "rconPort": "",               "rconPort": "port",
    "rconpass": ""                "rconpass": "password"
  },                            },
  
after that you can manually start bot with start-bot.vbs you will see bot in discord and will auto start at boot of your pc 
just use /with the name you have create when you have deploy the menu will show in that channel 
and inside windows gsm you need to add admin id of your bot

after enjoy menu to use wgsm with dynamic message no more spam

how the menu work
select serveur 
you can start /stop /stopall
on stop or stopall its auto dectect rcon to auto sent saveworld made for ark , so its you have rcon server but it need something different you have to add or modify in bot.js
list and stats from wgsm
reboot pc/shutdown pc same as stopll but at the end reboot or shutdown the pc 

