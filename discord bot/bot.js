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
const DEBUG = false;

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
const SERVERS_FILE = path.join(config.Path, 'status_name_ip.json');
const STATUS_FILE = SERVERS_FILE;

const BOT_CHANNEL_ID = String(config.channel_id).trim();
const WGSM_BOT_ID = String(config.wgsm).trim();
const MY_BOT_AUTHOR_ID = String(config.bot_author_id).trim();

const IGNORED_IDS = [];

const RCON_TIMEOUT_MS = 5000;
const RCON_POST_SAVE_DELAY_MS = 3000;

const OS_POWER_DELAY_SEC = 240;
const POST_STOPALL_DELAY_MS = 5000;
const FALLBACK_DELETE_DELAY_MS = 10000;
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

        const servers = Object.entries(data)
            .filter(([key]) => key !== '_meta')
            .map(([id, val]) => ({
                id,
                status: getStatusValue(val)
            }));

        const blocking = servers.filter(s => s.status !== 'STOPPED');

        if (blocking.length === 0) {
            logDebug('SAFE SHUTDOWN OK', servers);
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

async function deleteAndClearPending(type, key = null) {
    try {
        if (type === 'list') {
            const msg = pendingRawWgsmMessages.list;
            if (!msg) return;

            pendingRawWgsmMessages.list = null;
            await safeDeleteMessage(msg);
            return;
        }

        if (type === 'stats') {
            const msg = pendingRawWgsmMessages.stats;
            if (!msg) return;

            pendingRawWgsmMessages.stats = null;
            await safeDeleteMessage(msg);
            return;
        }

        if (type === 'stopall') {
            const msg = pendingRawWgsmMessages.stopall;
            if (!msg) return;

            pendingRawWgsmMessages.stopall = null;
            await safeDeleteMessage(msg);
            return;
        }

        if (type === 'startById') {
            const arr = pendingRawWgsmMessages.start[key];
            if (!Array.isArray(arr) || arr.length === 0) return;

            delete pendingRawWgsmMessages.start[key];

            for (const msg of arr) {
                await safeDeleteMessage(msg);
            }
            return;
        }

        if (type === 'stopById') {
            const arr = pendingRawWgsmMessages.stop[key];
            if (!Array.isArray(arr) || arr.length === 0) return;

            delete pendingRawWgsmMessages.stop[key];

            for (const msg of arr) {
                await safeDeleteMessage(msg);
            }
            return;
        }
    } catch (err) {
        logDebug('DELETE AND CLEAR ERROR', type, key, err?.message || err);
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

    // 1) if the selected server no longer exists
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

    // 2) if all server offline according to WGSM
    if (activeIds.length === 0) {
        lastSelectedServerId = null;
        lastSelectedServerWasActive = false;
        logDebug('NO ACTIVE SERVER -> null');
        return;
    }

    // 3) if the user already has a valid selection
    if (hasValidSelected) {
        // if the selected server has actually just switched to STOPPED,
        // We switch to the first asset
        if (currentStatus === 'STOPPED' && lastSelectedServerWasActive) {
            lastSelectedServerId = activeIds[0];
            lastSelectedServerWasActive = true;
            logDebug('SELECTED SERVER REALLY BECAME STOPPED -> switch to', lastSelectedServerId);
            return;
        }

        // otherwise we ALWAYS keep the manual selection
        lastSelectedServerWasActive = currentIsActive;
        logDebug('KEEP SELECTED SERVER ->', currentSelected, '| status =', currentStatus);
        return;
    }

    // 4) No valid selection -> take the first asset
    lastSelectedServerId = activeIds[0];
    lastSelectedServerWasActive = true;
    logDebug('NO VALID SELECTED -> sync to', lastSelectedServerId);
}

function schedulePendingDelete(type, key, delayMs = FALLBACK_DELETE_DELAY_MS) {
    setTimeout(async () => {
        await deleteAndClearPending(type, key);
    }, delayMs);
}
function scheduleStopAllDelete(delayMs = FALLBACK_DELETE_DELAY_MS) {
    setTimeout(async () => {
       await deleteAndClearPending('stopall');
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

    for (const id of Object.keys(pendingRawWgsmMessages.start)) {
        await deleteAndClearPending('startById', id);
    }

    for (const id of Object.keys(pendingRawWgsmMessages.stop)) {
        await deleteAndClearPending('stopById', id);
    }

    await deleteAndClearPending('stopall');
    await deleteAndClearPending('list');
    await deleteAndClearPending('stats');

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
function hasAnyStartedServer() {
    const data = readStatusFile();

    return Object.entries(data)
        .filter(([key]) => key !== '_meta')
        .some(([, value]) => getStatusValue(value) === 'STARTED');
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

        // ✅ Skip if same text
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

                    // ✅ after successful EDIT
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

            // ✅ after successful SEND
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
    const hasStartedServer = hasAnyStartedServer();

    if (availableServers.length > 0) {
        const menu = new StringSelectMenuBuilder()
            .setCustomId('select_server')
            .setPlaceholder('Choose a server')
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
                .setDisabled(isPowerActionRunning),

            new ButtonBuilder()
                .setCustomId('stopall')
                .setLabel('STOP ALL')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(isPowerActionRunning || !hasStartedServer)
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
            isPowerActionRunning ||
            status === 'STARTED' ||
            actionLock === 'start' ||
            actionLock === 'stop';

        const disableStop =
            isPowerActionRunning ||        
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
            content: 'Server Menu',
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
            content: 'Server Menu',
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
                `${action.summaryText} | ${action.type === 'shutdown' ? 'stop' : 'restart'} in 4 min`
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
    const actionLabel =
        actionName === 'shutdown' ? 'SHUTDOWN PC' :
            actionName === 'reboot' ? 'REBOOT PC' :
                actionName === 'stopall' ? 'STOP ALL' :
                    actionName.toUpperCase();

    await interaction.message.edit({
        content: `Confirmer ${actionLabel} ?`,
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
            content: 'Server Menu',
            components: buildInterface(lastSelectedServerId)
        });
    } catch (err) {
        logError('Erreur confirm edit :', err);
    }

    await upsertStatusMessage(
        interaction.channel,
        'live_status',
        `⏳ ${targetAction.toUpperCase()} in progress...`
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
        summary: '💾 OK:- | FAIL:-'
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
            '💾 OK:- | FAIL:-'
        );
    }

    const allStartedSaved = startedRconIds.every(serverId => rconResult.ok.includes(serverId));

    if (!allStartedSaved) {
        logDebug('POWER ACTION CANCELED BECAUSE RCON FAILED', targetAction);

        pendingPowerAction = null;
        isPowerActionRunning = false;

        await deleteAndClearPending('stopall');

        await upsertStatusMessage(
            interaction.channel,
            'live_status',
            `${rconResult.summary} | ${targetAction.toUpperCase()} CANCELED`
        );

        await interaction.message.edit({
            content: 'Server Menu',
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

    // ✅ If all servers are offline, we do not depend on WGSM stopall
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
            `${rconResult.summary} | ${targetAction.toUpperCase()} CANCELED (stopall not sent)`
        );

        await interaction.message.edit({
            content: 'Server Menu',
            components: buildInterface(lastSelectedServerId)
        }).catch(err => {
            logError('Erreur restore menu after stopall send fail :', err);
        });

        requestMenuRefresh(lastSelectedServerId);
        return;
    }
}

async function handleConfirmedStopAll(interaction) {
    logDebug('STOPALL CONFIRMED');
    isPowerActionRunning = true;

    try {
        await interaction.message.edit({
            content: 'Serveur Menu',
            components: buildInterface(lastSelectedServerId)
        });
    } catch (err) {
        logError('Erreur confirm stopall edit :', err);
    }

    await upsertStatusMessage(
        interaction.channel,
        'live_status',
        '⏳ STOP ALL en cours...'
    );

    const wgsmStartedIds = await getLatestStartedIdsFromWgsm(interaction.channel);

    const startedRconIds = getRconEnabledServers()
        .map(s => s.id)
        .filter(serverId => wgsmStartedIds.includes(serverId));

    logDebug(
        'STOPALL STARTED RCON IDS FROM WGSM',
        'wgsmStartedIds =', wgsmStartedIds,
        'startedRconIds =', startedRconIds
    );

    let rconResult = {
        ok: [],
        fail: [],
        summary: '💾 OK:- | FAIL:-'
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
            '💾 OK:- | FAIL:-'
        );
    }

    const allStartedSaved = startedRconIds.every(serverId => rconResult.ok.includes(serverId));

    if (!allStartedSaved) {
        logDebug('STOPALL CANCELED BECAUSE RCON FAILED');

        isPowerActionRunning = false;

        await deleteAndClearPending('stopall');

        await upsertStatusMessage(
            interaction.channel,
            'live_status',
            `${rconResult.summary} | STOPALL ANNULÉ`
        );

        await interaction.message.edit({
            content: 'Serveur Menu',
            components: buildInterface(lastSelectedServerId)
        }).catch(err => {
            logError('Erreur restore menu after canceled stopall :', err);
        });

        requestMenuRefresh(lastSelectedServerId);
        return;
    }

    if (wgsmStartedIds.length === 0) {
        logDebug('STOPALL NO STARTED SERVER -> DONE DIRECTLY');

        setAllStatusesStopped();
        lastSelectedServerId = null;
        lastSelectedServerWasActive = false;

        isPowerActionRunning = false;
        requestMenuRefresh(lastSelectedServerId);

        await upsertStatusMessage(
            interaction.channel,
            'live_status',
            `${rconResult.summary} | STOPALL terminé`
        );

        await interaction.message.edit({
            content: 'Serveur Menu',
            components: buildInterface(lastSelectedServerId)
        }).catch(err => {
            logError('Erreur restore menu after stopall direct done :', err);
        });

        return;
    }

    const cmdMsg = await sendWgsmCommand(interaction.channel, '!wgsm stopall');
    pendingRawWgsmMessages.stopall = cmdMsg || null;

    if (cmdMsg) {
        scheduleStopAllDelete();

        await waitForSafeShutdown();

        setAllStatusesStopped();
        lastSelectedServerId = null;
        lastSelectedServerWasActive = false;

        // délock tout de suite dès que l'arrêt est réellement fini
        isPowerActionRunning = false;

        if (pendingRawWgsmMessages.stopall) {
            await safeDeleteMessage(pendingRawWgsmMessages.stopall);
            pendingRawWgsmMessages.stopall = null;
        }

        requestMenuRefresh(lastSelectedServerId);

        await upsertStatusMessage(
            interaction.channel,
            'live_status',
            `${rconResult.summary} | STOPALL terminé`
        );

        await interaction.message.edit({
            content: 'Serveur Menu',
            components: buildInterface(lastSelectedServerId)
        }).catch(err => {
            logError('Erreur restore menu after stopall done :', err);
        });
    } else {
        logDebug('STOPALL FAILED -> CANCEL');

        isPowerActionRunning = false;

        await upsertStatusMessage(
            interaction.channel,
            'live_status',
            `${rconResult.summary} | STOPALL ANNULÉ (stopall non envoyé)`
        );

        await interaction.message.edit({
            content: 'Serveur Menu',
            components: buildInterface(lastSelectedServerId)
        }).catch(err => {
            logError('Erreur restore menu after stopall send fail :', err);
        });

        requestMenuRefresh(lastSelectedServerId);
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
                `💾 ${i + 1}/${uniqueIds.length} | FAIL:${fail.join(',') || '-'}`
            );
            continue;
        }

        if (!allowNonStarted && status !== 'STARTED') {
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
            `💾 ${i + 1}/${uniqueIds.length} | FAIL:${fail.join(',') || '-'}`
        );
    }

    const summary = `💾 OK:${ok.join(',') || '-'} | FAIL:${fail.join(',') || '-'}`;
    
    await upsertStatusMessage(channel, messageKey, summary);

    logDebug('RUN RCON SUMMARY', summary);

    return { ok, fail, summary };
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
    return content.replace(/\r/g, '').trim().toLowerCase().includes('all server offline.');
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
            await deleteAndClearPending('stats');
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

            await deleteAndClearPending('list');

            for (const item of parsedStatuses) {
                if (item.status === 'STARTED' && pendingRawWgsmMessages.start[item.id]?.length) {
                    await deleteAndClearPending('startById', item.id);
                }

                if (item.status === 'STOPPED' && pendingRawWgsmMessages.stop[item.id]?.length) {
                    await deleteAndClearPending('stopById', item.id);
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
                    await deleteAndClearPending('startById', id);
                    logDebug('START PENDING CLEARED', 'id =', id);
                }

            }

            if (status === 'STOPPED') {
                const pendingCount = pendingRawWgsmMessages.stop[id]?.length || 0;
                logDebug('WGSM STOPPED DETECTED', 'id =', id, 'pendingCount =', pendingCount);

                delete serverActionInProgress[id];

                if (pendingRawWgsmMessages.stop[id]?.length) {
                    await deleteAndClearPending('stopById', id);
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

function isRawWgsmCommand(content) {
    return /^!wgsm(\s|$)/i.test((content || '').trim());
}

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
        // Deletes !wgsm commands sent by other users
        // but does not touch your bot's messages or the WGSM bot itself.
        if (
            message.channel?.id === BOT_CHANNEL_ID &&
            isRawWgsmCommand(message.content) &&
            message.author?.id !== MY_BOT_AUTHOR_ID &&
            message.author?.id !== WGSM_BOT_ID
        ) {
            logDebug(
                'DELETE USER WGSM COMMAND AFTER 5S',
                'author =', message.author.id,
                'id =', message.id,
                'content =', message.content
            );

            setTimeout(async () => {
                try {
                    await safeDeleteMessage(message);
                } catch (_) { }
            }, 5000);
            return;
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

function getConfigIdList(key) {
    return Array.isArray(config[key])
        ? config[key].map(x => String(x).trim()).filter(Boolean)
        : [];
}

function isUserBlacklisted(userId) {
    return getConfigIdList('menu_blacklist').includes(String(userId));
}

function canUseMenu(userId) {
    const id = String(userId);
    const whitelist = getConfigIdList('menu_whitelist');

    if (isUserBlacklisted(id)) return false;

    // Si whitelist vide = tout le monde peut utiliser le menu, sauf blacklist
    if (whitelist.length === 0) return true;

    return whitelist.includes(id);
}

function canUsePowerButtons(userId) {
    const id = String(userId);
    const whitelist = getConfigIdList('power_whitelist');

    if (isUserBlacklisted(id)) return false;

    // Si whitelist vide = personne sauf si tu veux changer cette logique
    if (whitelist.length === 0) return false;

    return whitelist.includes(id);
}

client.on('interactionCreate', async interaction => {
    try {
        logDebug('INTERACTION', 'type =', interaction.type, 'customId =', interaction.customId || 'slash');
                logDebug(
                    'ACCESS CHECK',
                    'user =', interaction.user.id,
                    'blacklist =', getConfigIdList('menu_blacklist'),
                    'isBlacklisted =', isUserBlacklisted(interaction.user.id),
                    'menuWhitelist =', getConfigIdList('menu_whitelist'),
                    'powerWhitelist =', getConfigIdList('power_whitelist')
                );
        
                if (isUserBlacklisted(interaction.user.id)) {
                    if (interaction.isRepliable()) {
                        await interaction.reply({
                            content: '❌ Accès refusé.',
                            flags: MessageFlags.Ephemeral
                        }).catch(() => { });
                    }
                    return;
                }

        if (interaction.isChatInputCommand() && interaction.commandName === 'server') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const channel = await client.channels.fetch(BOT_CHANNEL_ID).catch(() => null);
            if (!channel || !channel.isTextBased()) {
                return interaction.editReply({ content: '❌ Channel not found.' }).catch(() => { });
            }

            const statusData = readStatusFile();
            syncSelectedServerFromStatusData(statusData);

            const savedMenuId = getStatusMessageId('main_menu');
            let menuMessage = null;

            // 1. Try directly with ID
            if (savedMenuId) {
                menuMessage = await channel.messages.fetch(savedMenuId).catch(() => null);
            }

            // 2. Fallback if not found
            if (!menuMessage) {
                menuMessage = await findMainMenuMessage(channel);

                if (menuMessage) {
                    setStatusMessageId('main_menu', menuMessage.id);
                }
            }

            // 3. If found → refresh
            if (menuMessage) {
                requestMenuRefresh(lastSelectedServerId);
            } else {
                // 4. otherwise create
                const msg = await channel.send({
                    content: 'Server Menu',
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

        if (
            (interaction.isStringSelectMenu() || interaction.isButton()) &&
            !canUseMenu(interaction.user.id)
        ) {
            if (!interaction.deferred && !interaction.replied) {
                await interaction.reply({
                    content: '❌ Tu n’es pas autorisé à utiliser ce menu.',
                    flags: MessageFlags.Ephemeral
                }).catch(() => { });
            }
            return;
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

        if (
            ['reboot', 'shutdown', 'stopall', 'confirm_reboot', 'confirm_shutdown', 'confirm_stopall']
                .includes(interaction.customId) &&
            !canUsePowerButtons(interaction.user.id)
        ) {
            await interaction.reply({
                content: '❌ Tu n’es pas autorisé à utiliser REBOOT / SHUTDOWN / STOP ALL.',
                flags: MessageFlags.Ephemeral
            }).catch(() => { });
            return;
        }        

        const ok = await safeDeferUpdate(interaction);
        if (!ok) return;

        const parts = interaction.customId.split('_');
        const action = parts[0];
        const id = parts.slice(1).join('_');
        const servers = getServers();
        const srv = servers.find(s => s.id === id);

        logDebug('BUTTON CLICK', 'action =', action, 'id =', id);

        if (id && action !== 'confirm' && action !== 'cancel') {
            // Never change the user selection simply because a button was clicked.
            // The selection should only change via the menu select_server
            // or if the selected server actually becomes STOPPED / no longer exists / all servers are offline.
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

        if (
            (interaction.customId === 'reboot' ||
                interaction.customId === 'shutdown' ||
                interaction.customId === 'stopall') &&
            isPowerActionRunning
        ) {
            logDebug('POWER BUTTON BLOCKED because action already running');
            return;
        }

        if (interaction.customId === 'stopall' && !hasAnyStartedServer()) {
            logDebug('STOPALL BLOCKED because no server is STARTED');

            setAllStatusesStopped();
            lastSelectedServerId = null;
            lastSelectedServerWasActive = false;

            await upsertStatusMessage(
                interaction.channel,
                'live_status',
                'Aucun serveur actif pour STOP ALL'
            );

            requestMenuRefresh(lastSelectedServerId);
            return;
        }

        if (
            interaction.customId === 'reboot' ||
            interaction.customId === 'shutdown' ||
            interaction.customId === 'stopall'
        ) {
            await showPowerConfirm(interaction, interaction.customId);
            return;
        }

        if (action === 'cancel') {
            pendingPowerAction = null;
            logDebug('POWER ACTION CANCELED');
            isPowerActionRunning = false;

            await interaction.message.edit({
                content: 'Server Menu',
                components: buildInterface(lastSelectedServerId)
            }).catch(err => {
                logError('Erreur cancel edit :', err);
            });

            return;
        }

        if (action === 'confirm') {
            const targetAction = id;

            if (targetAction === 'stopall') {
                await handleConfirmedStopAll(interaction);
                return;
            }

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
                        '💾 OK:- | FAIL:-'
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
                            summary: `💾 OK:- | FAIL:-`
                        };

                        if (isStarted) {
                            await upsertStatusMessage(
                                interaction.channel,
                                'live_status',
                                `⏳ attente save RCON | FAIL:-`
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
                                `${rconResult.summary} | STOP ${id} CANCELED`
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
                    srv.ip || 'empty IP'
                );
                break;
            }

            case 'pass': {
                await upsertStatusMessage(
                    interaction.channel,
                    'live_status',
                    srv.pass || 'empty PASS'
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