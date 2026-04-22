const {
    Client,
    GatewayIntentBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    MessageFlags,
    Partials
} = require('discord.js');

const fs = require('fs');
const path = require('path');
const config = require('./config.json');
const { Rcon } = require('rcon-client');
const { exec } = require('child_process');

// =======================
// 🔹 DEBUG
// =======================
const DEBUG = true;

function logDebug(...args) {
    if (!DEBUG) return;
    console.log('[DEBUG]', ...args);
}

function logError(...args) {
    console.error('[ERROR]', ...args);
}

// =======================
// 🔹 CLIENT
// =======================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [
        Partials.Message,
        Partials.Channel
    ]
});

// =======================
// 📁 CONFIG
// =======================
const SERVERS_FILE = path.join(config.wgsmPath, 'status_name_ip.json');
const STATUS_FILE = SERVERS_FILE;

const BOT_CHANNEL_ID = String(config.channel_id).trim();
const WGSM_BOT_ID = String(config.wgsm).trim();
const MY_BOT_AUTHOR_ID = String(config.bot_author_id).trim();

const IGNORED_IDS = ['250', '251'];

const RCON_TIMEOUT_MS = 5000;
const RCON_POST_SAVE_DELAY_MS = 3000;

const OS_POWER_DELAY_SEC = 240;
const POST_STOPALL_DELAY_MS = 5000;
const FALLBACK_DELETE_DELAY_MS = 5000;
const SERVER_ACTION_UNLOCK_MS = 60000;
const MENU_REFRESH_DEBOUNCE_MS = 100;

// =======================
// 🔹 STATE
// =======================
let pendingPowerAction = null;
let isPowerActionRunning = false;
let lastSelectedServerId = null;
let lastSelectedServerWasActive = false;
let menuUpdateSeq = 0;
let serverActionInProgress = {}; // { [id]: 'start' | 'stop' }
let lastStatusTextByKey = {};
let statusCache = null;

let pendingMenuRefreshTimer = null;
let pendingMenuRefreshSelectedId = null;
let lastMenuRenderSignature = null;
let powerActionExecuting = false;

let pendingRawWgsmMessages = {
    start: {},
    stop: {},
    stopall: null,
    list: null,
    stats: null
};

// =======================
// 🔹 HELPERS
// =======================
function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForSafeShutdown(pollMs = 1000) {
    while (true) {
        const data = readStatusFile();

        const active = Object.entries(data)
            .filter(([key]) => key !== '_meta')
            .map(([id, val]) => ({
                id,
                status: getStatusValue(val)
            }));

        const blocking = active.filter(s => s.status === 'STOPPED');

        if (blocking.length === 0) {
            logDebug('SAFE SHUTDOWN OK', active);
            return true;
        }

        logDebug('WAIT SHUTDOWN', blocking);
        await wait(pollMs);
    }
}

async function withTimeout(promise, ms, stepName = 'Opération') {
    let timeoutId;

    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`${stepName} timeout après ${ms}ms`));
        }, ms);
    });

    try {
        const result = await Promise.race([promise, timeoutPromise]);
        clearTimeout(timeoutId);
        return result;
    } catch (err) {
        clearTimeout(timeoutId);
        throw err;
    }
}

async function safeDeleteMessage(msg) {
    try {
        if (!msg) return;

        logDebug('DELETE MESSAGE TRY', msg.id);

        await msg.delete().catch(err => {
            if (err?.code === 10008) {
                logDebug('DELETE MESSAGE ALREADY GONE', msg.id);
                return;
            }

            logDebug('DELETE MESSAGE FAIL', msg.id, err?.message || err);
        });

        logDebug('DELETE MESSAGE DONE', msg.id);

    } catch (err) {
        logDebug('DELETE MESSAGE ERROR', err?.message || err);
    }
}

async function safeDeferUpdate(interaction) {
    try {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferUpdate();
        }
        return true;
    } catch (err) {
        if (err.code === 10062) {
            console.warn(`Interaction expirée/unknown: ${interaction.customId}`);
            return false;
        }
        console.error(`Erreur deferUpdate (${interaction.customId}) :`, err);
        return false;
    }
}

function scheduleServerActionUnlock(id, expectedAction) {
    setTimeout(() => {
        if (serverActionInProgress[id] === expectedAction) {
            delete serverActionInProgress[id];
            requestMenuRefresh(lastSelectedServerId);
        }
    }, SERVER_ACTION_UNLOCK_MS);
}

function getStatusValue(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && value.status) return value.status;
    return 'INCONNU';
}

function getActiveIdsFromStatusData(statusData) {
    return Object.entries(statusData)
        .filter(([key, value]) => {
            if (key === '_meta') return false;
            const status = getStatusValue(value);
            return status === 'STARTED';
        })
        .map(([key]) => key)
        .sort((a, b) => Number(a) - Number(b));
}

function syncSelectedServerFromStatusData(statusData) {
    const servers = getServers().map(s => String(s.id));
    const activeIds = getActiveIdsFromStatusData(statusData);
    const currentSelected = lastSelectedServerId ? String(lastSelectedServerId) : null;

    const hasValidSelected = currentSelected && servers.includes(currentSelected);
    const currentStatus = hasValidSelected ? getStatusValue(statusData[currentSelected]) : 'INCONNU';
    const currentIsActive = hasValidSelected && currentStatus === 'STARTED';

    // 1) si le serveur sélectionné n'existe plus
    if (currentSelected && !servers.includes(currentSelected)) {
        if (activeIds.length > 0) {
            lastSelectedServerId = activeIds[0];
            lastSelectedServerWasActive = true;
            logDebug('SELECTED SERVER NO LONGER EXISTS -> switch to', lastSelectedServerId);
        } else {
            lastSelectedServerId = null;
            lastSelectedServerWasActive = false;
            logDebug('SELECTED SERVER NO LONGER EXISTS -> null');
        }
        return;
    }

    // 2) si aucun serveur actif selon WGSM
    if (activeIds.length === 0) {
        lastSelectedServerId = null;
        lastSelectedServerWasActive = false;
        logDebug('NO ACTIVE SERVER -> null');
        return;
    }

    // 3) si l'utilisateur a déjà une sélection valide
    if (hasValidSelected) {
        // si le serveur sélectionné vient réellement de passer STOPPED,
        // on bascule vers le premier actif
        if (currentStatus === 'STOPPED' && lastSelectedServerWasActive) {
            lastSelectedServerId = activeIds[0];
            lastSelectedServerWasActive = true;
            logDebug('SELECTED SERVER REALLY BECAME STOPPED -> switch to', lastSelectedServerId);
            return;
        }

        // sinon on garde TOUJOURS la sélection manuelle
        lastSelectedServerWasActive = currentIsActive;
        logDebug('KEEP SELECTED SERVER ->', currentSelected, '| status =', currentStatus);
        return;
    }

    // 4) aucune sélection valable -> prendre le premier actif
    lastSelectedServerId = activeIds[0];
    lastSelectedServerWasActive = true;
    logDebug('NO VALID SELECTED -> sync to', lastSelectedServerId);
}

function schedulePendingDelete(type, key, delayMs = FALLBACK_DELETE_DELAY_MS) {
    setTimeout(async () => {
        try {
            if (type === 'list') {
                const msg = pendingRawWgsmMessages.list;
                if (!msg) return;

                logDebug('FALLBACK DELETE LIST', msg.id);
                await safeDeleteMessage(msg);

                if (pendingRawWgsmMessages.list?.id === msg.id) {
                    pendingRawWgsmMessages.list = null;
                }
                return;
            }

            if (type === 'stats') {
                const msg = pendingRawWgsmMessages.stats;
                if (!msg) return;

                logDebug('FALLBACK DELETE STATS', msg.id);
                await safeDeleteMessage(msg);

                if (pendingRawWgsmMessages.stats?.id === msg.id) {
                    pendingRawWgsmMessages.stats = null;
                }
                return;
            }

            if (type === 'startById') {
                const arr = pendingRawWgsmMessages.start[key];
                if (!Array.isArray(arr) || arr.length === 0) return;

                for (const msg of arr) {
                    logDebug('FALLBACK DELETE START', key, msg.id);
                    await safeDeleteMessage(msg);
                }

                delete pendingRawWgsmMessages.start[key];
                return;
            }

            if (type === 'stopById') {
                const arr = pendingRawWgsmMessages.stop[key];
                if (!Array.isArray(arr) || arr.length === 0) return;

                for (const msg of arr) {
                    logDebug('FALLBACK DELETE STOP', key, msg.id);
                    await safeDeleteMessage(msg);
                }

                delete pendingRawWgsmMessages.stop[key];
                return;
            }
        } catch (err) {
            logDebug('FALLBACK DELETE ERROR', type, key, err?.message || err);
        }
    }, delayMs);
}
function scheduleStopAllDelete(delayMs = FALLBACK_DELETE_DELAY_MS) {
    setTimeout(async () => {
        try {
            const msg = pendingRawWgsmMessages.stopall;
            if (!msg) return;

            logDebug('FALLBACK DELETE STOPALL', msg.id);
            await safeDeleteMessage(msg);

            if (pendingRawWgsmMessages.stopall?.id === msg.id) {
                pendingRawWgsmMessages.stopall = null;
            }
        } catch (err) {
            logDebug('FALLBACK DELETE STOPALL ERROR', err?.message || err);
        }
    }, delayMs);
}
function getSelectedStatus() {
    if (!lastSelectedServerId) return 'INCONNU';
    return getStatus(lastSelectedServerId);
}

async function handleWgsmEmptyList(channel = null) {
    logDebug('WGSM EMPTY LIST DETECTED');

    setAllStatusesStopped();

    for (const id of Object.keys(serverActionInProgress)) {
        delete serverActionInProgress[id];
    }

    pendingRawWgsmMessages.start = {};
    pendingRawWgsmMessages.stop = {};
    pendingRawWgsmMessages.stopall = null;
    pendingRawWgsmMessages.list = null;
    pendingRawWgsmMessages.stats = null;

    syncSelectedServerFromStatusData(readStatusFile());
    requestMenuRefresh(lastSelectedServerId);

    if (pendingPowerAction) {
        executePendingPowerAction().catch(err => {
            logError('Erreur executePendingPowerAction after empty list :', err);
        });
    }
}
function ensureServerEntry(data, id) {
    if (!data[id] || typeof data[id] !== 'object' || Array.isArray(data[id])) {
        data[id] = {
            status: 'STOPPED',
            name: '',
            ip: '',
            pass: '',
            update: 'UPDATE'
        };
    }

    return data[id];
}

// =======================
// 🔹 SERVERS
// =======================
function getServers() {
    if (!fs.existsSync(SERVERS_FILE)) return [];

    try {
        const data = JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8'));

        const servers = Object.entries(data)
            .filter(([id]) => !id.startsWith('_'))
            .map(([id, srv]) => ({
                id,
                name: srv.name || `Server ${id}`,
                ip: srv.ip || '',
                pass: srv.pass || '',
                update: srv.update || 'UPDATE',
                rconHost: srv.rconhost ? String(srv.rconhost).trim() : null,
                rconPort: srv.rconPort ? Number(srv.rconPort) : null,
                rconPass: srv.rconpass ? String(srv.rconpass).trim() : null
            }));

        logDebug('GET SERVERS OK', 'count =', servers.length);
        return servers;
    } catch (err) {
        logError('Erreur lecture status_name_ip.json :', err);
        return [];
    }
}

function getRconEnabledServers() {
    const servers = getServers().filter(
        s => s.rconHost && s.rconPort && s.rconPass
    );
    logDebug('GET RCON ENABLED SERVERS', servers.map(s => s.id));
    return servers;
}

// =======================
// 🔹 STATUS FILE
// =======================
function readStatusFile() {
    if (statusCache) return statusCache;

    if (!fs.existsSync(STATUS_FILE)) {
        statusCache = {};
        return statusCache;
    }

    try {
        statusCache = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
        return statusCache;
    } catch (err) {
        logError('Erreur lecture status_name_ip.json :', err);
        statusCache = {};
        return statusCache;
    }
}

function writeStatusFile(data) {
    try {
        statusCache = data;
        fs.writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2), 'utf8');
        logDebug('WRITE STATUS FILE OK');
    } catch (err) {
        logError('Erreur écriture status_name_ip.json :', err);
    }
}

function getStatus(id) {
    const data = readStatusFile();
    return getStatusValue(data[id]);
}

function saveStatus(id, status) {
    const data = readStatusFile();

    const entry = ensureServerEntry(data, id);
    entry.status = status;
    writeStatusFile(data);
    logDebug('SAVE STATUS', 'id =', id, 'status =', status);
}

function setAllStatusesStopped() {
    const servers = getServers();
    const data = readStatusFile();

    for (const srv of servers) {
        const entry = ensureServerEntry(data, srv.id);
        entry.status = 'STOPPED';
    }

    writeStatusFile(data);
    logDebug('SET ALL STATUSES STOPPED');
}

function setStatusesFromStartedIds(startedIds) {
    const servers = getServers();
    const data = readStatusFile();
    const startedSet = new Set(startedIds.map(String));

    for (const srv of servers) {
        const entry = ensureServerEntry(data, srv.id);
        entry.status = startedSet.has(String(srv.id)) ? 'STARTED' : 'STOPPED';
    }

    writeStatusFile(data);
    logDebug('SET STATUSES FROM STARTED IDS', [...startedSet]);
}

function getStatusMessageId(key) {
    const data = readStatusFile();
    return data?._meta?.messages?.[key] || null;
}

function setStatusMessageId(key, messageId) {
    const data = readStatusFile();

    if (!data._meta || typeof data._meta !== 'object') data._meta = {};
    if (!data._meta.messages || typeof data._meta.messages !== 'object') {
        data._meta.messages = {};
    }

    data._meta.messages[key] = messageId;
    writeStatusFile(data);
    logDebug('SET STATUS MESSAGE ID', key, messageId);
}

function removeStatusMessageId(key) {
    const data = readStatusFile();

    if (data?._meta?.messages?.[key]) {
        delete data._meta.messages[key];
        writeStatusFile(data);
        logDebug('REMOVE STATUS MESSAGE ID', key);
    }
}

// =======================
// 🔹 STATUS MESSAGE UNIQUE
// =======================
async function upsertStatusMessage(channel, key, text) {
    try {
        const savedMessageId = getStatusMessageId(key);

        // ✅ skip si même texte
        if (lastStatusTextByKey[key] === text) {
            logDebug('UPSERT STATUS MESSAGE SKIP SAME TEXT', key);
            return null;
        }

        logDebug('UPSERT STATUS MESSAGE', 'key =', key, 'savedMessageId =', savedMessageId, 'text =', text);

        if (savedMessageId) {
            try {
                const oldMsg = await channel.messages.fetch(savedMessageId).catch(() => null);
                if (oldMsg) {
                    await oldMsg.edit({ content: text }).catch(() => { });

                    // ✅ après EDIT réussi
                    lastStatusTextByKey[key] = text;

                    logDebug('UPSERT EDIT OK', key, oldMsg.id);
                    return oldMsg;
                }
            } catch (_) { }

            removeStatusMessageId(key);
            delete lastStatusTextByKey[key];
        }

        const newMsg = await channel.send({ content: text }).catch(() => null);

        if (newMsg) {
            setStatusMessageId(key, newMsg.id);

            // ✅ après SEND réussi
            lastStatusTextByKey[key] = text;

            logDebug('UPSERT SEND OK', key, newMsg.id);
        }

        return newMsg;
    } catch (err) {
        logError(`Erreur upsertStatusMessage (${key}) :`, err);
        return null;
    }
}

// =======================
// 🔹 WGSM COMMAND
// =======================
async function sendWgsmCommand(channel, commandText) {
    try {
        logDebug('SEND WGSM COMMAND', commandText);
        const msg = await channel.send(commandText).catch(() => null);

        if (msg) {
            logDebug('WGSM COMMAND SENT', commandText, 'msgId =', msg.id);
        } else {
            logDebug('WGSM COMMAND FAILED', commandText);
        }

        return msg;
    } catch (err) {
        logError(`Erreur sendWgsmCommand (${commandText}) :`, err);
        return null;
    }
}

// =======================
// 🔹 MENU
// =======================
function buildInterface(selectedId = null) {
    const servers = getServers();
    const components = [];

    const availableServers = servers.filter(s => !IGNORED_IDS.includes(s.id));

    if (availableServers.length > 0) {
        const menu = new StringSelectMenuBuilder()
            .setCustomId('select_server')
            .setPlaceholder('Choisir un serveur')
            .addOptions(
                availableServers.map(s => ({
                    label: s.name,
                    value: s.id,
                    default: s.id === selectedId
                }))
            );

        components.push(new ActionRowBuilder().addComponents(menu));
    }

    components.push(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('list')
                .setLabel('LIST')
                .setStyle(ButtonStyle.Secondary),

            new ButtonBuilder()
                .setCustomId('stats')
                .setLabel('STATS')
                .setStyle(ButtonStyle.Secondary)
        )
    );

    components.push(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('reboot')
                .setLabel('REBOOT PC')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(isPowerActionRunning),

            new ButtonBuilder()
                .setCustomId('shutdown')
                .setLabel('SHUTDOWN PC')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(isPowerActionRunning)
        )
    );

    if (selectedId) {
        const srv = servers.find(s => s.id === selectedId);
        if (!srv) return components;

        const status = getStatus(selectedId);
        const actionLock = serverActionInProgress[srv.id] || null;

        let statusLabel = 'STOPPED';
        let statusStyle = ButtonStyle.Danger;

        if (status === 'STARTED') {
            statusLabel = 'STARTED';
            statusStyle = ButtonStyle.Success;
        }

        const disableStart =
            status === 'STARTED' ||
            actionLock === 'start' ||
            actionLock === 'stop';

        const disableStop =
            status === 'STOPPED' ||
            actionLock === 'start' ||
            actionLock === 'stop';

        components.push(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`start_${srv.id}`)
                    .setLabel('START')
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(disableStart),

                new ButtonBuilder()
                    .setCustomId(`status_${srv.id}`)
                    .setLabel(statusLabel)
                    .setStyle(statusStyle)
                    .setDisabled(true),

                new ButtonBuilder()
                    .setCustomId(`stop_${srv.id}`)
                    .setLabel('STOP')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(disableStop)
            )
        );

        components.push(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`ip_${srv.id}`)
                    .setLabel('IP')
                    .setStyle(ButtonStyle.Secondary),

                new ButtonBuilder()
                    .setCustomId(`pass_${srv.id}`)
                    .setLabel('PASS')
                    .setStyle(ButtonStyle.Secondary),

                new ButtonBuilder()
                    .setCustomId(`update_${srv.id}`)
                    .setLabel(srv.update || 'UPDATE')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true)
            )
        );
    }

    return components;
}

async function findMainMenuMessage(channel) {
    try {
        const messages = await channel.messages.fetch({ limit: 5 });

        const found = messages.find(m =>
            m.author.id === client.user.id &&
            m.components?.some(row =>
                row.components?.some(c => c.customId === 'select_server')
            )
        );

        logDebug('FIND MAIN MENU MESSAGE', found?.id || 'none');
        return found;
    } catch (err) {
        logError('Erreur recherche message menu :', err);
        return null;
    }
}
function requestMenuRefresh(serverId = null, delayMs = MENU_REFRESH_DEBOUNCE_MS) {
    pendingMenuRefreshSelectedId = serverId ?? lastSelectedServerId ?? null;

    if (pendingMenuRefreshTimer) {
        clearTimeout(pendingMenuRefreshTimer);
    }

    pendingMenuRefreshTimer = setTimeout(async () => {
        const selected = pendingMenuRefreshSelectedId;
        pendingMenuRefreshTimer = null;
        pendingMenuRefreshSelectedId = null;

        try {
            await updateMenuStatus(selected);
        } catch (err) {
            logError('Erreur requestMenuRefresh :', err);
        }
    }, delayMs);
}

async function updateMenuStatus(serverId = null) {
    const seq = ++menuUpdateSeq;

    try {
        const channel = await client.channels.fetch(BOT_CHANNEL_ID).catch(() => null);
        if (!channel || !channel.isTextBased()) return;

        const savedMenuId = getStatusMessageId('main_menu');
        let menuMessage = null;

        if (savedMenuId) {
            menuMessage = await channel.messages.fetch(savedMenuId).catch(() => null);
        }

        if (!menuMessage) {
            menuMessage = await findMainMenuMessage(channel);

            if (menuMessage) {
                setStatusMessageId('main_menu', menuMessage.id);
            }
        }

        if (!menuMessage) {
            logDebug('UPDATE MENU STATUS', 'menu not found');
            return;
        }

        const selected = serverId ?? lastSelectedServerId ?? null;
        const components = buildInterface(selected);

        const signature = JSON.stringify({
            content: 'Gestion serveur',
            selected,
            components: components.map(row => ({
                components: row.components.map(c => ({
                    customId: c.data?.custom_id,
                    label: c.data?.label,
                    style: c.data?.style,
                    disabled: c.data?.disabled,
                    placeholder: c.data?.placeholder,
                    options: c.data?.options
                }))
            }))
        });

        if (signature === lastMenuRenderSignature) {
            logDebug('UPDATE MENU STATUS SKIP SAME RENDER', 'selected =', selected);
            return;
        }

        if (seq !== menuUpdateSeq) {
            logDebug(
                'UPDATE MENU STATUS SKIP OUTDATED BEFORE EDIT',
                'selected =', selected,
                'seq =', seq,
                'current =', menuUpdateSeq
            );
            return;
        }

        await menuMessage.edit({
            content: 'Gestion serveur',
            components
        }).catch(err => {
            logDebug('UPDATE MENU STATUS EDIT FAIL', err?.message || err);
        });

        if (seq !== menuUpdateSeq) {
            logDebug(
                'UPDATE MENU STATUS OUTDATED AFTER EDIT',
                'selected =', selected,
                'seq =', seq,
                'current =', menuUpdateSeq
            );
            return;
        }

        lastMenuRenderSignature = signature;

        logDebug('UPDATE MENU STATUS OK', 'selected =', selected);
    } catch (err) {
        logError('Erreur update menu status :', err);
    }
}

// =======================
// 🔹 POWER
// =======================
function scheduleShutdownComputer() {
    return new Promise((resolve, reject) => {
        logDebug('OS SHUTDOWN COMMAND', `shutdown /s /t ${OS_POWER_DELAY_SEC} /f`);
        exec(`shutdown /s /t ${OS_POWER_DELAY_SEC} /f`, error => {
            if (error) return reject(error);
            logDebug('OS SHUTDOWN COMMAND OK');
            resolve();
        });
    });
}

function scheduleRebootComputer() {
    return new Promise((resolve, reject) => {
        logDebug('OS REBOOT COMMAND', `shutdown /r /t ${OS_POWER_DELAY_SEC} /f`);
        exec(`shutdown /r /t ${OS_POWER_DELAY_SEC} /f`, error => {
            if (error) return reject(error);
            logDebug('OS REBOOT COMMAND OK');
            resolve();
        });
    });
}

async function executePendingPowerAction() {
    if (!pendingPowerAction || powerActionExecuting) return;

    powerActionExecuting = true;
    const action = pendingPowerAction;
    pendingPowerAction = null;

    try {
        logDebug('EXECUTE PENDING POWER ACTION', action);
        await wait(POST_STOPALL_DELAY_MS);

        if (action.type === 'shutdown') {
            await scheduleShutdownComputer();
        } else if (action.type === 'reboot') {
            await scheduleRebootComputer();
        }

        isPowerActionRunning = false;

        const channel = await client.channels.fetch(action.channelId).catch(() => null);
        if (channel && channel.isTextBased()) {
            await upsertStatusMessage(
                channel,
                'live_status',
                `${action.summaryText} | ${action.type === 'shutdown' ? 'arrêt' : 'redémarrage'} dans 4 min`
            );
        }

        requestMenuRefresh(lastSelectedServerId);
    } catch (err) {
        logError(`Erreur executePendingPowerAction (${action.type}) :`, err);

        isPowerActionRunning = false;

        const channel = await client.channels.fetch(action.channelId).catch(() => null);
        if (channel && channel.isTextBased()) {
            await upsertStatusMessage(
                channel,
                'live_status',
                `${action.summaryText} | ERREUR ${action.type.toUpperCase()}`
            );
        }

        requestMenuRefresh(lastSelectedServerId);
    } finally {
        powerActionExecuting = false;
    }
}

async function showPowerConfirm(interaction, actionName) {
    await interaction.message.edit({
        content: `Confirmer ${actionName.toUpperCase()} ?`,
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`confirm_${actionName}`)
                    .setLabel('CONFIRM')
                    .setStyle(ButtonStyle.Danger),

                new ButtonBuilder()
                    .setCustomId(`cancel_${actionName}`)
                    .setLabel('CANCEL')
                    .setStyle(ButtonStyle.Secondary)
            )
        ]
    }).catch(err => {
        logError('Erreur showPowerConfirm :', err);
    });
}

async function handleConfirmedPowerAction(interaction, targetAction) {
    logDebug('POWER ACTION CONFIRMED', targetAction);
    isPowerActionRunning = true;

    try {
        await interaction.message.edit({
            content: 'Gestion serveur',
            components: buildInterface(lastSelectedServerId)
        });
    } catch (err) {
        logError('Erreur confirm edit :', err);
    }

    await upsertStatusMessage(
        interaction.channel,
        'live_status',
        `⏳ ${targetAction.toUpperCase()} en cours...`
    );

    const wgsmStartedIds = await getLatestStartedIdsFromWgsm(interaction.channel);

    const startedRconIds = getRconEnabledServers()
        .map(s => s.id)
        .filter(serverId => wgsmStartedIds.includes(serverId));

    logDebug(
        'POWER ACTION STARTED RCON IDS FROM WGSM',
        'targetAction =', targetAction,
        'wgsmStartedIds =', wgsmStartedIds,
        'startedRconIds =', startedRconIds
    );

    let rconResult = {
        ok: [],
        fail: [],
        off: [],
        summary: '💾 OK:- | FAIL:- | SERVEUR ETEINT:-'
    };

    if (startedRconIds.length > 0) {
        rconResult = await runRconForIds(
            interaction.channel,
            startedRconIds,
            'live_status',
            { allowNonStarted: true }
        );
    } else {
        await upsertStatusMessage(
            interaction.channel,
            'live_status',
            '💾 OK:- | FAIL:- | SERVEUR ETEINT:-'
        );
    }

    const allStartedSaved = startedRconIds.every(serverId => rconResult.ok.includes(serverId));

    if (!allStartedSaved) {
        logDebug('POWER ACTION CANCELED BECAUSE RCON FAILED', targetAction);

        pendingPowerAction = null;
        isPowerActionRunning = false;

        if (pendingRawWgsmMessages.stopall) {
            await safeDeleteMessage(pendingRawWgsmMessages.stopall);
            pendingRawWgsmMessages.stopall = null;
        }

        await upsertStatusMessage(
            interaction.channel,
            'live_status',
            `${rconResult.summary} | ${targetAction.toUpperCase()} ANNULÉ`
        );

        await interaction.message.edit({
            content: 'Gestion serveur',
            components: buildInterface(lastSelectedServerId)
        }).catch(err => {
            logError('Erreur restore menu after canceled power action :', err);
        });

        requestMenuRefresh(lastSelectedServerId);
        return;
    }

    pendingPowerAction = {
        type: targetAction,
        channelId: interaction.channel.id,
        summaryText: rconResult.summary
    };

    // ✅ SI AUCUN SERVEUR ACTIF, on ne dépend pas de WGSM stopall
    if (wgsmStartedIds.length === 0) {
        logDebug('POWER ACTION NO STARTED SERVER -> EXECUTE DIRECTLY', targetAction);
        await executePendingPowerAction();
        return;
    }

    const cmdMsg = await sendWgsmCommand(interaction.channel, '!wgsm stopall');
    pendingRawWgsmMessages.stopall = cmdMsg || null;

    if (cmdMsg) {
        scheduleStopAllDelete();

        (async () => {
            await waitForSafeShutdown();

            if (!pendingPowerAction) return;

            logDebug('STOPALL FINISHED FROM STATUS FILE');
            await executePendingPowerAction();
        })();
    } else {
        logDebug('STOPALL FAILED -> CANCEL POWER ACTION');

        pendingPowerAction = null;
        isPowerActionRunning = false;

        await upsertStatusMessage(
            interaction.channel,
            'live_status',
            `${rconResult.summary} | ${targetAction.toUpperCase()} ANNULÉ (stopall non envoyé)`
        );

        await interaction.message.edit({
            content: 'Gestion serveur',
            components: buildInterface(lastSelectedServerId)
        }).catch(err => {
            logError('Erreur restore menu after stopall send fail :', err);
        });

        requestMenuRefresh(lastSelectedServerId);
        return;
    }
}

// =======================
// 🔹 RCON
// =======================
async function saveServerRconStrict(server) {
    let rcon = null;
    let gotValidSaveResponse = false;
    let responseText = '';

    try {
        if (!server || !server.rconHost || !server.rconPort || !server.rconPass) {
            return { success: false, response: '', reason: 'NO_RCON' };
        }

        logDebug(
            'RCON START',
            'server =', server.name,
            'id =', server.id,
            'host =', server.rconHost,
            'port =', server.rconPort
        );

        rcon = new Rcon({
            host: server.rconHost,
            port: Number(server.rconPort),
            password: server.rconPass
        });

        rcon.on('error', err => {
            const msg = err?.message || String(err);

            if (
                gotValidSaveResponse &&
                (msg.includes('ECONNRESET') ||
                    msg.includes('Socket closed') ||
                    msg.includes('Connection closed'))
            ) {
                return;
            }

            logDebug(`RCON ERROR`, server.name, server.id, msg);
        });

        await withTimeout(
            rcon.connect(),
            RCON_TIMEOUT_MS,
            `Connexion RCON ${server.id}`
        );

        logDebug('RCON CONNECT OK', 'id =', server.id);

        const response = await withTimeout(
            rcon.send('saveworld'),
            RCON_TIMEOUT_MS,
            `Commande saveworld ${server.id}`
        );

        responseText = response || '';
        logDebug('RCON RESPONSE', 'id =', server.id, 'response =', responseText);

        gotValidSaveResponse =
            typeof responseText === 'string' &&
            responseText.toLowerCase().includes('saved');

        await wait(RCON_POST_SAVE_DELAY_MS);

        try {
            await Promise.race([
                rcon.end(),
                wait(1500)
            ]);
        } catch (_) { }

        logDebug('RCON RESULT', 'id =', server.id, 'success =', gotValidSaveResponse);

        return {
            success: gotValidSaveResponse,
            response: responseText
        };
    } catch (err) {
        const msg = err?.message || String(err);

        try {
            if (rcon) await rcon.end().catch(() => { });
        } catch (_) { }

        if (
            gotValidSaveResponse &&
            (msg.includes('ECONNRESET') ||
                msg.includes('Socket closed') ||
                msg.includes('Connection closed'))
        ) {
            logDebug('RCON END ERROR IGNORED AFTER SAVE', 'id =', server?.id, 'reason =', msg);

            return {
                success: true,
                response: responseText,
                reason: msg
            };
        }

        logDebug('RCON FAIL', 'id =', server?.id, 'reason =', msg);

        return {
            success: false,
            response: responseText,
            reason: msg
        };
    }
}

async function runRconForIds(channel, targetIds, messageKey = 'live_status', options = {}) {
    const servers = getServers();
    const uniqueIds = [...new Set(targetIds)];
    const allowNonStarted = options.allowNonStarted === true;

    const ok = [];
    const fail = [];
    const off = [];

    logDebug('RUN RCON FOR IDS', uniqueIds, 'allowNonStarted =', allowNonStarted);

    for (let i = 0; i < uniqueIds.length; i++) {
        const id = uniqueIds[i];
        const srv = servers.find(s => s.id === id);
        const status = getStatus(id);

        if (!srv || !srv.rconHost || !srv.rconPort || !srv.rconPass) {
            fail.push(id);

            await upsertStatusMessage(
                channel,
                messageKey,
                `💾 ${i + 1}/${uniqueIds.length} | FAIL:${fail.join(',') || '-'} | SERVEUR ETEINT:${off.join(',') || '-'}`
            );
            continue;
        }

        if (!allowNonStarted && status !== 'STARTED') {
            off.push(id);

            await upsertStatusMessage(
                channel,
                messageKey,
                `💾 ${i + 1}/${uniqueIds.length} | FAIL:${fail.join(',') || '-'} | SERVEUR ETEINT:${off.join(',') || '-'}`
            );
            continue;
        }

        const result = await saveServerRconStrict(srv);

        if (result.success) {
            ok.push(id);
        } else {
            fail.push(id);
        }

        await upsertStatusMessage(
            channel,
            messageKey,
            `💾 ${i + 1}/${uniqueIds.length} | FAIL:${fail.join(',') || '-'} | SERVEUR ETEINT:${off.join(',') || '-'}`
        );
    }

    const summary =
        `💾 OK:${ok.join(',') || '-'} | ` +
        `FAIL:${fail.join(',') || '-'} | ` +
        `SERVEUR ETEINT:${off.join(',') || '-'}`;

    await upsertStatusMessage(channel, messageKey, summary);

    logDebug('RUN RCON SUMMARY', summary);

    return { ok, fail, off, summary };
}

// =======================
// 🔹 WGSM PARSER
// =======================
function parseStatusFromLine(line) {
    const m = line.match(/🆔\s*(\d+)\s*\|\s*(🟢|🔴|🟡|🟠|🔵)\s*(Started|Stopped|already\s+Stopped|Starting|Stopping|Updating)/i);
    if (!m) return null;

    const id = m[1];
    const emoji = m[2];
    const word = m[3].toLowerCase().replace(/\s+/g, ' ').trim();

    if (emoji === '🟢' || word === 'started') {
        return { id, status: 'STARTED' };
    }
    if (emoji === '🔴' || word === 'stopped' || word === 'already stopped') {
        return { id, status: 'STOPPED' };
    }
    if (emoji === '🟡' || word === 'starting') {
        return { id, status: 'STARTING' };
    }
    if (emoji === '🟠' || word === 'stopping') {
        return { id, status: 'STOPPING' };
    }
    if (emoji === '🔵' || word === 'updating') {
        return { id, status: 'UPDATING' };
    }

    return null;
}

function isStatsMessage(content) {
    return /Server name\s*:/i.test(content || '');
}

function isEmptyListMessage(content) {
    if (!content) return false;
    return content.replace(/\r/g, '').trim().toLowerCase().includes('aucun serveur actif.');
}

async function getLatestStartedIdsFromWgsm(channel) {
    try {
        const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
        if (!messages) return [];

        const wgsmMessages = [...messages.values()]
            .filter(m => m.author?.id === WGSM_BOT_ID && m.content)
            .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

        for (const msg of wgsmMessages) {
            const content = (msg.content || '').trim();
            if (!content) continue;

            if (isStatsMessage(content)) continue;

            if (isEmptyListMessage(content)) {
                await handleWgsmEmptyList(channel);
                return [];
            }

            const lines = content
                .split('\n')
                .map(x => x.trim())
                .filter(Boolean);

            const parsedStatuses = [];

            for (const line of lines) {
                const parsed = parseStatusFromLine(line);
                if (parsed) parsedStatuses.push(parsed);
            }

            if (parsedStatuses.length > 0) {
                const terminalStatuses = parsedStatuses.filter(
                    x => x.status === 'STARTED' || x.status === 'STOPPED'
                );

                if (terminalStatuses.length === 0) {
                    continue;
                }

                const startedIds = terminalStatuses
                    .filter(x => x.status === 'STARTED')
                    .map(x => x.id)
                    .sort((a, b) => Number(a) - Number(b));

                logDebug('WGSM LIVE STARTED IDS', 'messageId =', msg.id, 'startedIds =', startedIds);
                return startedIds;
            }
        }

        logDebug('WGSM LIVE STARTED IDS', 'no usable WGSM message found');
        return [];
    } catch (err) {
        logError('Erreur getLatestStartedIdsFromWgsm :', err);
        return [];
    }
}

async function handleWgsmStatusMessage(message) {
    try {
        if (!message || message.author.id !== WGSM_BOT_ID) return;

        const content = (message.content || '').trim();
        if (!content) return;

        logDebug(
            'WGSM MESSAGE RECEIVED',
            'author =', message.author.id,
            'messageId =', message.id,
            'content =', content.replace(/\n/g, ' | ')
        );

        if (isStatsMessage(content)) {
            logDebug('WGSM STATS MESSAGE DETECTED');
            if (pendingRawWgsmMessages.stats) {
                await safeDeleteMessage(pendingRawWgsmMessages.stats);
                pendingRawWgsmMessages.stats = null;
            }
            return;
        }

        if (isEmptyListMessage(content)) {
            await handleWgsmEmptyList(message.channel);
            return;
        }

        const lines = content
            .split('\n')
            .map(x => x.trim())
            .filter(Boolean);

        const parsedStatuses = [];

        for (const line of lines) {
            const parsed = parseStatusFromLine(line);
            if (parsed) parsedStatuses.push(parsed);
        }

        logDebug('PARSED STATUSES COUNT', parsedStatuses.length, parsedStatuses);

        if (parsedStatuses.length === 0) return;

        if (pendingRawWgsmMessages.list) {
            const startedIds = parsedStatuses
                .filter(x => x.status === 'STARTED')
                .map(x => x.id);

            logDebug('WGSM LIST DETECTED', 'startedIds =', startedIds);

            setStatusesFromStartedIds(startedIds);

            await safeDeleteMessage(pendingRawWgsmMessages.list);
            pendingRawWgsmMessages.list = null;

            for (const item of parsedStatuses) {
                if (item.status === 'STARTED' && pendingRawWgsmMessages.start[item.id]?.length) {
                    for (const msg of pendingRawWgsmMessages.start[item.id]) {
                        logDebug('LIST DELETE START MSG', 'id =', item.id, 'msgId =', msg.id);
                        await safeDeleteMessage(msg);
                    }
                    delete pendingRawWgsmMessages.start[item.id];
                }

                if (item.status === 'STOPPED' && pendingRawWgsmMessages.stop[item.id]?.length) {
                    for (const msg of pendingRawWgsmMessages.stop[item.id]) {
                        logDebug('LIST DELETE STOP MSG', 'id =', item.id, 'msgId =', msg.id);
                        await safeDeleteMessage(msg);
                    }
                    delete pendingRawWgsmMessages.stop[item.id];
                }
            }

            const statusDataAfterList = readStatusFile();
            syncSelectedServerFromStatusData(statusDataAfterList);

            const hasTerminalStatus = parsedStatuses.some(
                x => x.status === 'STARTED' || x.status === 'STOPPED'
            );

            if (hasTerminalStatus) {
                await updateMenuStatus(lastSelectedServerId);
            }
            return;
        }

        const statusData = readStatusFile();
        let changed = false;

        for (const item of parsedStatuses) {
            const { id, status } = item;
            const current = getStatusValue(statusData[id]);

            logDebug('WGSM STATUS PARSED', 'id =', id, 'status =', status, 'current =', current);

            const entry = ensureServerEntry(statusData, id);

            if ((status === 'STARTED' || status === 'STOPPED') && current !== status) {
                entry.status = status;
                changed = true;
                logDebug('STATUS UPDATED', 'id =', id, 'old =', current, 'new =', status);
            }

            if (status === 'STARTED') {
                const pendingCount = pendingRawWgsmMessages.start[id]?.length || 0;
                logDebug('WGSM STARTED DETECTED', 'id =', id, 'pendingCount =', pendingCount);

                delete serverActionInProgress[id];

                if (pendingRawWgsmMessages.start[id]?.length) {
                    for (const msg of pendingRawWgsmMessages.start[id]) {
                        logDebug('DELETE START MSG', 'id =', id, 'msgId =', msg.id);
                        await safeDeleteMessage(msg);
                    }
                    delete pendingRawWgsmMessages.start[id];
                    logDebug('START PENDING CLEARED', 'id =', id);
                }

            }

            if (status === 'STOPPED') {
                const pendingCount = pendingRawWgsmMessages.stop[id]?.length || 0;
                logDebug('WGSM STOPPED DETECTED', 'id =', id, 'pendingCount =', pendingCount);

                delete serverActionInProgress[id];

                if (pendingRawWgsmMessages.stop[id]?.length) {
                    for (const msg of pendingRawWgsmMessages.stop[id]) {
                        logDebug('DELETE STOP MSG', 'id =', id, 'msgId =', msg.id);
                        await safeDeleteMessage(msg);
                    }
                    delete pendingRawWgsmMessages.stop[id];
                    logDebug('STOP PENDING CLEARED', 'id =', id);
                }

            }
        }

        if (!changed) {
            return;
        }

        writeStatusFile(statusData);
        syncSelectedServerFromStatusData(statusData);
        requestMenuRefresh(lastSelectedServerId);
    } catch (err) {
        logError('Erreur traitement message WGSM :', err);
    }
}

async function bootstrapFromRecentWgsmMessages() {
    try {
        const channel = await client.channels.fetch(BOT_CHANNEL_ID).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            logDebug('BOOTSTRAP WGSM', 'channel not found');
            return;
        }

        const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
        if (!messages) {
            logDebug('BOOTSTRAP WGSM', 'fetch messages failed');
            return;
        }

        const wgsmMessages = [...messages.values()]
            .filter(m => m.author?.id === WGSM_BOT_ID && m.content)
            .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

        logDebug('BOOTSTRAP WGSM', 'found =', wgsmMessages.length);

        for (const msg of wgsmMessages) {
            const content = (msg.content || '').trim();
            if (!content) continue;

            if (isStatsMessage(content)) continue;

            if (isEmptyListMessage(content)) {
                setAllStatusesStopped();
                lastSelectedServerId = null;
                requestMenuRefresh(null);
                logDebug('BOOTSTRAP USED EMPTY MESSAGE', msg.id);
                return;
            }

            const lines = content
                .split('\n')
                .map(x => x.trim())
                .filter(Boolean);

            const parsedStatuses = [];

            for (const line of lines) {
                const parsed = parseStatusFromLine(line);
                if (parsed) parsedStatuses.push(parsed);
            }

            if (parsedStatuses.length > 0) {
                const terminalStatuses = parsedStatuses.filter(
                    x => x.status === 'STARTED' || x.status === 'STOPPED'
                );

                if (terminalStatuses.length === 0) {
                    continue;
                }

                const startedIds = terminalStatuses
                    .filter(x => x.status === 'STARTED')
                    .map(x => x.id);

                setStatusesFromStartedIds(startedIds);

                const statusData = readStatusFile();
                syncSelectedServerFromStatusData(statusData);
                requestMenuRefresh(lastSelectedServerId);

                logDebug('BOOTSTRAP USED STATUS MESSAGE', msg.id, terminalStatuses);
                return;
            }
        }

        logDebug('BOOTSTRAP WGSM', 'no usable message found');
    } catch (err) {
        logError('Erreur bootstrapFromRecentWgsmMessages :', err);
    }
}

// =======================
// 🔹 EVENTS
// =======================
client.on('messageCreate', async message => {
    try {
        if (!message) return;

        if (message.partial) {
            logDebug('MESSAGE CREATE PARTIAL FETCH', 'id =', message.id);
            message = await message.fetch().catch(() => null);
            if (!message) {
                logDebug('MESSAGE CREATE FETCH FAILED');
                return;
            }
        }

        if (message.author?.id === MY_BOT_AUTHOR_ID || message.author?.id === WGSM_BOT_ID) {
            logDebug(
                'MESSAGE CREATE',
                'author =', message.author.id,
                'id =', message.id,
                'content =', message.content
            );
        }

        await handleWgsmStatusMessage(message);
    } catch (err) {
        logError('Erreur messageCreate :', err);
    }
});

client.on('messageUpdate', async (_, newMessage) => {
    try {
        if (!newMessage) return;

        if (newMessage.partial) {
            logDebug('MESSAGE UPDATE PARTIAL FETCH', 'id =', newMessage.id);
            newMessage = await newMessage.fetch().catch(() => null);
            if (!newMessage) {
                logDebug('MESSAGE UPDATE FETCH FAILED');
                return;
            }
        }

        logDebug(
            'MESSAGE UPDATE',
            'author =', newMessage.author?.id,
            'id =', newMessage.id,
            'content =', newMessage.content
        );

        await handleWgsmStatusMessage(newMessage);
    } catch (err) {
        logError('Erreur messageUpdate :', err);
    }
});

client.once('clientReady', async () => {
    console.log('Bot prêt :', client.user.tag);
    await bootstrapFromRecentWgsmMessages();
});

// =======================
// 🔹 INTERACTIONS
// =======================
client.on('interactionCreate', async interaction => {
    try {
        logDebug('INTERACTION', 'type =', interaction.type, 'customId =', interaction.customId || 'slash');

        if (interaction.isChatInputCommand() && interaction.commandName === 'server') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const channel = await client.channels.fetch(BOT_CHANNEL_ID).catch(() => null);
            if (!channel || !channel.isTextBased()) {
                return interaction.editReply({ content: '❌ Canal introuvable.' }).catch(() => { });
            }

            const statusData = readStatusFile();
            syncSelectedServerFromStatusData(statusData);

            const savedMenuId = getStatusMessageId('main_menu');
            let menuMessage = null;

            // 1. essayer direct avec ID
            if (savedMenuId) {
                menuMessage = await channel.messages.fetch(savedMenuId).catch(() => null);
            }

            // 2. fallback si introuvable
            if (!menuMessage) {
                menuMessage = await findMainMenuMessage(channel);

                if (menuMessage) {
                    setStatusMessageId('main_menu', menuMessage.id);
                }
            }

            // 3. si trouvé → refresh
            if (menuMessage) {
                requestMenuRefresh(lastSelectedServerId);
            } else {
                // 4. sinon créer
                const msg = await channel.send({
                    content: 'Gestion serveur',
                    components: buildInterface(lastSelectedServerId)
                }).catch(err => {
                    logError('Erreur create menu /server :', err);
                    return null;
                });

                if (msg) {
                    setStatusMessageId('main_menu', msg.id);
                }
            }

            return interaction.deleteReply().catch(() => { });
        }

        if (interaction.isStringSelectMenu() && interaction.customId === 'select_server') {
            const ok = await safeDeferUpdate(interaction);
            if (!ok) return;

            lastSelectedServerId = interaction.values[0];

            const status = getStatus(lastSelectedServerId);
            lastSelectedServerWasActive = status === 'STARTED';

            logDebug('SELECT SERVER', lastSelectedServerId, '| status =', status);

            requestMenuRefresh(lastSelectedServerId);

            return;
        }

        if (!interaction.isButton()) return;

        const ok = await safeDeferUpdate(interaction);
        if (!ok) return;

        const [action, id] = interaction.customId.split('_');
        const servers = getServers();
        const srv = servers.find(s => s.id === id);

        logDebug('BUTTON CLICK', 'action =', action, 'id =', id);

        if (id && action !== 'confirm' && action !== 'cancel') {
            // Ne jamais changer la sélection utilisateur juste parce qu’un bouton a été cliqué.
            // La sélection ne doit changer que via le menu select_server
            // ou si le serveur sélectionné devient réellement STOPPED / n’existe plus / aucun serveur actif.
            logDebug('KEEP USER SELECTION ON BUTTON', 'clickedId =', id, 'selected =', lastSelectedServerId);
        }

        if (interaction.customId === 'list') {
            const msg = await sendWgsmCommand(interaction.channel, '!wgsm list');
            pendingRawWgsmMessages.list = msg || null;
            logDebug('LIST STORED', msg?.id || 'none');

            if (msg) {
                schedulePendingDelete('list', null, FALLBACK_DELETE_DELAY_MS);
            }
            return;
        }

        if (interaction.customId === 'stats') {
            const msg = await sendWgsmCommand(interaction.channel, '!wgsm stats');
            pendingRawWgsmMessages.stats = msg || null;
            logDebug('STATS STORED', msg?.id || 'none');

            if (msg) {
                schedulePendingDelete('stats', null, FALLBACK_DELETE_DELAY_MS);
            }
            return;
        }

        if (action === 'status' || action === 'update') {
            return;
        }

        if ((interaction.customId === 'reboot' || interaction.customId === 'shutdown') && isPowerActionRunning) {
            logDebug('POWER BUTTON BLOCKED because action already running');
            return;
        }

        if (interaction.customId === 'reboot' || interaction.customId === 'shutdown') {
            await showPowerConfirm(interaction, interaction.customId);
            return;
        }

        if (action === 'cancel') {
            pendingPowerAction = null;
            logDebug('POWER ACTION CANCELED');
            isPowerActionRunning = false;

            await interaction.message.edit({
                content: 'Gestion serveur',
                components: buildInterface(lastSelectedServerId)
            }).catch(err => {
                logError('Erreur cancel edit :', err);
            });

            return;
        }

        if (action === 'confirm') {
            const targetAction = id;
            await handleConfirmedPowerAction(interaction, targetAction);
            return;
        }

        if (!srv) return;

        switch (action) {
            case 'start': {
                logDebug('START CLICK', 'id =', id, 'status =', getStatus(id));

                if (serverActionInProgress[id]) {
                    logDebug('SERVER ACTION ALREADY IN PROGRESS', 'id =', id, 'action =', serverActionInProgress[id]);
                    return;
                }

                if (pendingRawWgsmMessages.start[id]?.length) {
                    logDebug('START ALREADY PENDING', 'id =', id);
                    return;
                }

                serverActionInProgress[id] = 'start';
                requestMenuRefresh(lastSelectedServerId);
                scheduleServerActionUnlock(id, 'start');

                try {
                    const cmdMsg = await sendWgsmCommand(interaction.channel, `!wgsm start ${id}`);

                    await upsertStatusMessage(
                        interaction.channel,
                        'live_status',
                        '💾 OK:- | FAIL:- | SERVEUR ETEINT:-'
                    );

                    if (cmdMsg) {
                        pendingRawWgsmMessages.start[id] = [cmdMsg];

                        logDebug(
                            'START STORED',
                            'id =', id,
                            'msgId =', cmdMsg.id,
                            'count =', pendingRawWgsmMessages.start[id].length
                        );

                        schedulePendingDelete('startById', id, FALLBACK_DELETE_DELAY_MS);
                    } else {
                        logDebug('START NOT STORED', 'id =', id);

                        delete serverActionInProgress[id];
                        requestMenuRefresh(lastSelectedServerId);
                        return;
                    }
                } catch (err) {
                    delete serverActionInProgress[id];
                    requestMenuRefresh(lastSelectedServerId);
                    throw err;
                }

                break;
            }

            case 'stop': {
                logDebug('STOP CLICK', 'id =', id, 'status =', getStatus(id));

                if (serverActionInProgress[id]) {
                    logDebug('SERVER ACTION ALREADY IN PROGRESS', 'id =', id, 'action =', serverActionInProgress[id]);
                    return;
                }

                if (pendingRawWgsmMessages.stop[id]?.length) {
                    logDebug('STOP ALREADY PENDING', 'id =', id);
                    return;
                }

                const previousStatus = getStatus(id);

                serverActionInProgress[id] = 'stop';
                requestMenuRefresh(lastSelectedServerId);
                scheduleServerActionUnlock(id, 'stop');

                try {
                    if (srv.rconHost && srv.rconPort && srv.rconPass) {
                        const wgsmStartedIds = await getLatestStartedIdsFromWgsm(interaction.channel);
                        const isStarted = wgsmStartedIds.includes(id);

                        let rconResult = {
                            ok: [],
                            fail: [],
                            off: [],
                            summary: `💾 OK:- | FAIL:- | SERVEUR ETEINT:${id}`
                        };

                        if (isStarted) {
                            await upsertStatusMessage(
                                interaction.channel,
                                'live_status',
                                `⏳ attente save RCON | FAIL:- | SERVEUR ETEINT:${id}`
                            );

                            rconResult = await runRconForIds(
                                interaction.channel,
                                [id],
                                'live_status',
                                { allowNonStarted: true }
                            );
                        } else {
                            await upsertStatusMessage(
                                interaction.channel,
                                'live_status',
                                rconResult.summary
                            );
                        }

                        const saved = rconResult.ok.includes(id);

                        logDebug(
                            'STOP RCON RESULT',
                            'id =', id,
                            'wgsmStartedIds =', wgsmStartedIds,
                            'isStarted =', isStarted,
                            'saved =', saved
                        );

                        if (isStarted && !saved) {
                            saveStatus(id, previousStatus || 'STARTED');

                            if (lastSelectedServerId) {
                                lastSelectedServerWasActive = getSelectedStatus() === 'STARTED';
                            }

                            delete serverActionInProgress[id];
                            requestMenuRefresh(lastSelectedServerId);

                            await upsertStatusMessage(
                                interaction.channel,
                                'live_status',
                                `${rconResult.summary} | STOP ${id} ANNULÉ`
                            );
                            return;
                        }

                        if (!isStarted) {
                            logDebug('STOP WITHOUT RCON SAVE because WGSM says server is not started', 'id =', id);
                        }
                    }

                    if (lastSelectedServerId) {
                        const selectedStatus = getStatus(lastSelectedServerId);
                        lastSelectedServerWasActive = selectedStatus === 'STARTED';
                    }

                    const cmdMsg = await sendWgsmCommand(interaction.channel, `!wgsm stop ${id}`);

                    if (cmdMsg) {
                        pendingRawWgsmMessages.stop[id] = [cmdMsg];

                        logDebug(
                            'STOP STORED',
                            'id =', id,
                            'msgId =', cmdMsg.id,
                            'count =', pendingRawWgsmMessages.stop[id].length
                        );

                        schedulePendingDelete('stopById', id, FALLBACK_DELETE_DELAY_MS);
                    } else {
                        logDebug('STOP NOT STORED', 'id =', id);

                        saveStatus(id, previousStatus || 'STARTED');

                        if (lastSelectedServerId) {
                            const selectedStatus = getStatus(lastSelectedServerId);
                            lastSelectedServerWasActive = selectedStatus === 'STARTED';
                        }

                        delete serverActionInProgress[id];
                        requestMenuRefresh(lastSelectedServerId);
                        return;
                    }
                } catch (err) {
                    saveStatus(id, previousStatus || 'STARTED');

                    if (lastSelectedServerId) {
                        const selectedStatus = getStatus(lastSelectedServerId);
                        lastSelectedServerWasActive = selectedStatus === 'STARTED';
                    }

                    delete serverActionInProgress[id];
                    requestMenuRefresh(lastSelectedServerId);
                    throw err;
                }

                break;
            }

            case 'ip': {
                await upsertStatusMessage(
                    interaction.channel,
                    'live_status',
                    srv.ip || 'Aucun IP'
                );
                break;
            }

            case 'pass': {
                await upsertStatusMessage(
                    interaction.channel,
                    'live_status',
                    srv.pass || 'Aucun PASS'
                );
                break;
            }
        }
    } catch (err) {
        logError('Erreur interactionCreate :', err);
    }
});

// =======================
// 🔹 PROTECTION
// =======================
process.on('unhandledRejection', err => {
    if (err?.code === 'ECONNRESET') {
        console.warn('Unhandled rejection ignoré (ECONNRESET) :', err.message);
        return;
    }
    console.error('Unhandled promise rejection :', err);
});

process.on('uncaughtException', err => {
    if (err?.code === 'ECONNRESET') {
        console.warn('Uncaught exception ignorée (ECONNRESET) :', err.message);
        return;
    }
    console.error('Uncaught exception :', err);
});

client.on('error', err => {
    console.error('Discord client error :', err);
});

client.on('shardError', err => {
    if (err?.code === 'ECONNRESET') {
        console.warn('Discord shard error ignorée (ECONNRESET) :', err.message);
        return;
    }
    console.error('Discord shard error :', err);
});

client.on('warn', info => {
    console.warn('Discord warn :', info);
});

// =======================
// 🔹 LOGIN
// =======================
client.login(config.token);