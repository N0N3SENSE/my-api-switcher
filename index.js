import { extension_settings } from '../../../../../scripts/extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../../script.js';
import { SECRET_KEYS, writeSecret, readSecretState, secret_state } from '../../../../../scripts/secrets.js';
import { oai_settings } from '../../../../../scripts/openai.js';

let rotateSecret = null;
try {
    const m = await import('../../../../../scripts/secrets.js');
    rotateSecret = m.rotateSecret || null;
} catch (e) { /* 旧版没有就算了 */ }

const MODULE = 'my_api_switcher';
const TITLE = 'API切换器';
const REPO = 'N0N3SENSE/my-api-switcher';
const FOLDER = new URL(import.meta.url).pathname.split('/').slice(-2, -1)[0];

let editingId = null;
let fetchKeyCache = { value: '', id: null };
let topBannerTimer = null;
let currentVersion = '';
let updateState = { checked: false, hasUpdate: false, remote: '', local: '' };
let drawerView = 'main'; // 'main' | 'form' | 'settings'

function S() { return extension_settings[MODULE]; }

function initSettings() {
    if (!extension_settings[MODULE]) extension_settings[MODULE] = {};
    const s = extension_settings[MODULE];
    if (!Array.isArray(s.configs)) s.configs = [];
    if (!s.collapsed) s.collapsed = {};
    if (s.showBall === undefined) s.showBall = true;
    if (s.theme === undefined) s.theme = 'follow'; // 'light' | 'dark' | 'follow'
    if (s.lastId === undefined) s.lastId = null;

    // 清理旧版不再需要的开关字段
    delete s.autoConnect;
    delete s.autoUpdateCheck;
}

function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function getFirstChar(name) {
    return (Array.from((name || '').trim())[0] || '?').toUpperCase();
}

// ---------- 顶部提示条 ----------
function showTopBanner(message) {
    let banner = $('#asw-top-banner');
    if (!banner.length) {
        banner = $('<div id="asw-top-banner" role="status" aria-live="polite"></div>').appendTo('body');
    }
    clearTimeout(topBannerTimer);
    banner.text(message).removeClass('asw-banner-hide').addClass('asw-banner-show');
    topBannerTimer = setTimeout(() => {
        banner.removeClass('asw-banner-show').addClass('asw-banner-hide');
    }, 3000);
}

// ---------- 密钥 ----------
async function activateKey(cfg) {
    if (!cfg.key) return;
    if (!secret_state || Object.keys(secret_state).length === 0) await readSecretState();
    const list = Array.isArray(secret_state?.[SECRET_KEYS.CUSTOM]) ? secret_state[SECRET_KEYS.CUSTOM] : [];
    if (cfg.secretId && list.some(x => x?.id === cfg.secretId)) {
        if (rotateSecret) await rotateSecret(SECRET_KEYS.CUSTOM, cfg.secretId);
        return;
    }
    const id = await writeSecret(SECRET_KEYS.CUSTOM, cfg.key, `ASW: ${cfg.name}`);
    if (id) {
        cfg.secretId = id;
        saveSettingsDebounced();
    }
}

// ---------- 应用配置 ----------
function setModel(model) {
    if (!model) return;
    oai_settings.custom_model = model;
    $('#custom_model_id').val(model).trigger('input');
    const sel = $('#model_custom_select');
    if (sel.length && sel.is('select')) {
        if (sel.find(`option[value="${model}"]`).length === 0) {
            sel.append($('<option>').val(model).text(model));
        }
        sel.val(model).trigger('change');
    }
}

async function applyConfig(cfg, quiet) {
    try {
        if (!$('#api_button_openai').length || !$('#chat_completion_source').length) {
            throw new Error('没找到API连接界面');
        }
        $('#chat_completion_source').val('custom').trigger('change');
        oai_settings.chat_completion_source = 'custom';

        $('#custom_api_url_text').val(cfg.url || '').trigger('input');
        oai_settings.custom_url = cfg.url || '';

        await activateKey(cfg);
        setModel(cfg.model);

        S().lastId = cfg.id;
        saveSettingsDebounced();

        $('#api_button_openai').trigger('click');

        if (cfg.model) {
            setTimeout(() => setModel(cfg.model), 2000);
            setTimeout(() => setModel(cfg.model), 5000);
        }

        if (!quiet) {
            toastr.success(`正在连接: ${cfg.name}`, TITLE);
            const appliedLabel = cfg.model ? `应用模型成功：${cfg.model}` : `应用配置成功：${cfg.name}`;
            showTopBanner(appliedLabel);
        }
        renderList();
        renderDrawer();
        updateBallLabel();
    } catch (e) {
        console.error('[ASW] 应用失败', e);
        toastr.error(`应用失败: ${e.message}`, TITLE);
    }
}

// ---------- 获取模型 ----------
function resetModelSelect() {
    $('#asw-model-select').empty().append($('<option>').val('').text('选择模型（先点获取模型）'));
}

async function fetchModels() {
    const url = $('#asw-url').val().trim();
    const key = $('#asw-key').val().trim();
    if (!url) {
        toastr.error('请先填 API URL', TITLE);
        return;
    }
    const btn = $('#asw-fetch');
    const old = btn.text();
    btn.text('获取中...').prop('disabled', true);
    try {
        if (key) {
            if (fetchKeyCache.value !== key) {
                const id = await writeSecret(SECRET_KEYS.CUSTOM, key, 'ASW: 获取模型');
                fetchKeyCache = { value: key, id };
            } else if (fetchKeyCache.id && rotateSecret) {
                await rotateSecret(SECRET_KEYS.CUSTOM, fetchKeyCache.id);
            }
        }
        const res = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                chat_completion_source: 'custom',
                custom_url: url,
                reverse_proxy: '',
                proxy_password: '',
            }),
            cache: 'no-cache',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.error || !Array.isArray(data.data)) throw new Error('连接失败，检查URL和密钥');
        const models = data.data.map(m => m.id).sort((a, b) => a.localeCompare(b));
        const sel = $('#asw-model-select').empty().append($('<option>').val('').text('选择模型...'));
        models.forEach(id => sel.append($('<option>').val(id).text(id)));
        toastr.success(`获取到 ${models.length} 个模型`, TITLE);
    } catch (e) {
        toastr.error(`获取失败: ${e.message}`, TITLE);
    } finally {
        btn.text(old).prop('disabled', false);
    }
}

// ---------- 保存/编辑/删除 ----------
function clearForm() {
    $('#asw-name, #asw-group, #asw-url, #asw-key, #asw-model').val('');
    resetModelSelect();
    editingId = null;
    $('#asw-save').text('保存配置');
    $('#asw-cancel').hide();
}

function saveConfig() {
    const name = $('#asw-name').val().trim();
    const group = $('#asw-group').val().trim();
    const url = $('#asw-url').val().trim();
    const key = $('#asw-key').val().trim();
    const model = $('#asw-model').val().trim();

    if (!name) return toastr.error('请输入配置名称', TITLE);
    if (!url) return toastr.error('请输入API URL', TITLE);

    const list = S().configs;
    if (editingId) {
        const old = list.find(c => c.id === editingId);
        if (old) {
            const keyChanged = old.key !== key;
            Object.assign(old, { name, group, url, key, model });
            if (keyChanged) old.secretId = undefined;
            toastr.success(`已更新: ${name}`, TITLE);
        }
    } else {
        list.push({ id: uid(), name, group, url, key, model });
        toastr.success(`已保存: ${name}`, TITLE);
    }
    saveSettingsDebounced();
    clearForm();
    renderList();
    renderDrawer();
    updateBallLabel();
}

function editConfig(id) {
    const c = S().configs.find(x => x.id === id);
    if (!c) return;
    $('#asw-name').val(c.name);
    $('#asw-group').val(c.group || '');
    $('#asw-url').val(c.url || '');
    $('#asw-key').val(c.key || '');
    $('#asw-model').val(c.model || '');
    resetModelSelect();
    editingId = id;
    $('#asw-save').text('更新配置');
    $('#asw-cancel').show();
    $('#asw-name')[0].scrollIntoView({ behavior: 'smooth' });
}

function deleteConfig(id) {
    const c = S().configs.find(x => x.id === id);
    if (!c) return;
    if (!confirm(`确定删除 "${c.name}" 吗？`)) return;
    S().configs = S().configs.filter(x => x.id !== id);
    if (S().lastId === id) S().lastId = null;
    saveSettingsDebounced();
    renderList();
    renderDrawer();
    updateBallLabel();
}

// ---------- 扩展页列表 ----------
function renderList() {
    const box = $('#asw-list').empty();
    const cfgs = S().configs;
    if (!cfgs.length) {
        box.append($('<div class="asw-empty">').text('暂无保存的配置'));
        return;
    }
    const groups = {};
    cfgs.forEach(c => {
        const g = c.group || '未分组';
        if (!groups[g]) groups[g] = [];
        groups[g].push(c);
    });
    Object.keys(groups).sort().forEach(g => {
        const collapsed = !!S().collapsed[g];
        const head = $('<div class="asw-group-head">').attr('data-group', g)
            .append($('<i class="fa-solid">').addClass(collapsed ? 'fa-chevron-right' : 'fa-chevron-down'))
            .append($('<span>').text(' ' + g))
            .append($('<span class="asw-count">').text(` (${groups[g].length})`));
        const body = $('<div class="asw-group-body">').toggle(!collapsed);
        groups[g].forEach(c => {
            const item = $('<div class="asw-item">').toggleClass('asw-current', c.id === S().lastId);
            const info = $('<div class="asw-info">')
                .append($('<div class="asw-name">').text(c.name))
                .append($('<div class="asw-model">').text(c.model ? `首选模型: ${c.model}` : '未设置模型'));
            const acts = $('<div class="asw-actions">')
                .append($('<button class="menu_button asw-apply">').attr('data-id', c.id).text('应用'))
                .append($('<button class="menu_button asw-edit">').attr('data-id', c.id).text('编辑'))
                .append($('<button class="menu_button asw-del">').attr('data-id', c.id).text('删除'));
            body.append(item.append(info, acts));
        });
        box.append(head, body);
    });
}

// ---------- 外观主题 ----------
function applyDrawerTheme() {
    const drawer = $('#asw-drawer');
    if (!drawer.length) return;
    const mode = S().theme || 'follow';
    drawer.removeClass('asw-theme-light asw-theme-dark asw-theme-follow');
    drawer.addClass(`asw-theme-${mode}`);
    drawer.find('.asw-theme-btn').removeClass('active');
    drawer.find(`.asw-theme-btn[data-theme="${mode}"]`).addClass('active');
}

// ---------- 底部抽屉面板 ----------
function openDrawer(view) {
    if (view) drawerView = view;
    applyDrawerTheme();
    renderDrawer();
    $('#asw-drawer-backdrop').addClass('open');
    $('#asw-drawer').addClass('open');
}

function closeDrawer() {
    $('#asw-drawer').removeClass('open');
    $('#asw-drawer-backdrop').removeClass('open');
}

function renderDrawer() {
    const drawer = $('#asw-drawer');
    if (!drawer.length) return;

    drawer.find('.asw-drawer-view').hide();
    drawer.find(`.asw-drawer-view[data-view="${drawerView}"]`).show();

    if (drawerView === 'main') {
        const listBox = drawer.find('#asw-drawer-list').empty();
        const cfgs = S().configs;
        if (!cfgs.length) {
            listBox.append($('<div class="asw-empty">').text('暂无配置，点击右上角 + 添加'));
        } else {
            cfgs.forEach(c => {
                const isCur = c.id === S().lastId;
                const card = $('<div class="asw-drawer-card">').toggleClass('asw-current', isCur);
                const badge = $('<div class="asw-card-badge">').text(getFirstChar(c.name));
                const meta = $('<div class="asw-card-meta">')
                    .append($('<div class="asw-card-title">').text(c.name))
                    .append($('<div class="asw-card-sub">').text(c.model ? `首选模型: ${c.model}` : (c.url || '未设置模型')));
                const applyBtn = $('<button class="menu_button asw-drawer-apply">')
                    .attr('data-id', c.id)
                    .text(isCur ? '当前使用中 · 重新应用' : '应用');
                card.append(badge, meta, applyBtn);
                listBox.append(card);
            });
        }
    } else if (drawerView === 'settings') {
        drawer.find('#asw-drawer-ball-toggle').prop('checked', !!S().showBall);
        applyDrawerTheme();
    }
}

function createDrawerUI() {
    $('#asw-drawer-backdrop, #asw-drawer').remove();

    const backdrop = $('<div id="asw-drawer-backdrop"></div>').appendTo('body');
    const drawer = $(`
    <div id="asw-drawer" class="asw-theme-follow" role="dialog" aria-label="${TITLE}">
        <div class="asw-drawer-handle"></div>
        <div class="asw-drawer-header">
            <div class="asw-drawer-brand">
                <span class="asw-drawer-icon"><i class="fa-solid fa-plug"></i></span>
                <b>${TITLE}</b>
            </div>
            <div class="asw-drawer-actions">
                <button type="button" id="asw-drawer-to-main" class="asw-icon-btn" title="配置列表"><i class="fa-solid fa-list"></i></button>
                <button type="button" id="asw-drawer-to-form" class="asw-icon-btn" title="新增配置"><i class="fa-solid fa-plus"></i></button>
                <button type="button" id="asw-drawer-to-settings" class="asw-icon-btn" title="设置"><i class="fa-solid fa-sliders"></i></button>
                <button type="button" id="asw-drawer-close" class="asw-icon-btn" title="关闭"><i class="fa-solid fa-xmark"></i></button>
            </div>
        </div>
        <div class="asw-drawer-body">
            <div class="asw-drawer-view" data-view="main">
                <div id="asw-drawer-list"></div>
            </div>
            <div class="asw-drawer-view" data-view="form" style="display:none;">
                <div class="flex-container flexFlowColumn flexGap5">
                    <input type="text" id="asw-qd-name" class="text_pole" placeholder="配置名称 (例如: OpenAI GPT-4)">
                    <input type="text" id="asw-qd-group" class="text_pole" placeholder="分组名称 (可选)">
                    <input type="text" id="asw-qd-url" class="text_pole" placeholder="Custom API URL (例如: https://api.openai.com/v1)">
                    <input type="password" id="asw-qd-key" class="text_pole" placeholder="Custom API密钥 (可选)">
                    <input type="text" id="asw-qd-model" class="text_pole" placeholder="首选模型 (可选)">
                    <button type="button" id="asw-qd-save" class="menu_button">保存配置</button>
                </div>
            </div>
            <div class="asw-drawer-view" data-view="settings" style="display:none;">
                <div class="asw-setting-block">
                    <div class="asw-setting-label">外观主题</div>
                    <div class="asw-theme-group">
                        <button type="button" class="menu_button asw-theme-btn" data-theme="light"><i class="fa-solid fa-sun"></i> 日间</button>
                        <button type="button" class="menu_button asw-theme-btn" data-theme="dark"><i class="fa-solid fa-moon"></i> 夜间</button>
                        <button type="button" class="menu_button asw-theme-btn" data-theme="follow"><i class="fa-solid fa-circle-half-stroke"></i> 跟随酒馆</button>
                    </div>
                </div>
                <div class="asw-setting-block">
                    <label class="checkbox_label">
                        <input type="checkbox" id="asw-drawer-ball-toggle">
                        <span>显示悬浮球（侧边贴边，点击打开面板）</span>
                    </label>
                </div>
            </div>
        </div>
    </div>`).appendTo('body');

    applyDrawerTheme();
    renderDrawer();
}

function mountWandMenuEntry() {
    if ($('#asw-wand-item').length) return;
    const item = $(`
        <div id="asw-wand-item" class="list-group-item flex-container flexGap5 interactable" tabindex="0" role="button">
            <i class="fa-solid fa-plug"></i>
            <span>${TITLE}</span>
        </div>
    `);

    const menu = $('#extensionsMenu');
    if (menu.length) {
        menu.append(item);
        return;
    }

    // 若魔法棒菜单尚未挂载，监听其展开时再补挂
    const btn = $('#extensionsMenuButton');
    if (btn.length) {
        btn.on('click.aswWand', () => {
            setTimeout(() => {
                if (!$('#asw-wand-item').length && $('#extensionsMenu').length) {
                    $('#extensionsMenu').append(item);
                }
            }, 50);
        });
    }
}

// ---------- 轻量吸边悬浮球 ----------
function updateBallLabel() {
    const ball = $('#asw-float-ball');
    if (!ball.length) return;
    const cur = S().configs.find(x => x.id === S().lastId);
    ball.text(cur ? getFirstChar(cur.name) : 'A');
    ball.attr('title', cur ? `${TITLE} · 当前: ${cur.name}` : TITLE);
}

function placeBallAt(x, y, snapEdge) {
    const ball = $('#asw-float-ball');
    if (!ball.length) return { x: 0, y: 0 };
    const w = ball.outerWidth() || 36;
    const h = ball.outerHeight() || 36;
    const maxX = Math.max(0, window.innerWidth - w);
    const maxY = Math.max(0, window.innerHeight - h);

    let nx = Math.max(0, Math.min(maxX, x));
    const ny = Math.max(8, Math.min(maxY - 8, y));

    if (snapEdge) {
        const centerX = nx + w / 2;
        nx = centerX < window.innerWidth / 2 ? 0 : maxX;
        ball.toggleClass('asw-docked-left', nx === 0);
        ball.toggleClass('asw-docked-right', nx === maxX);
    } else {
        ball.removeClass('asw-docked-left asw-docked-right');
    }

    ball.css({ left: nx + 'px', top: ny + 'px' });
    return { x: nx, y: ny };
}

function syncFloatBall() {
    $('#asw-float-ball').remove();
    if (!S().showBall) return;

    const ball = $('<div id="asw-float-ball" role="button" tabindex="0"></div>').appendTo('body');
    updateBallLabel();

    const defaultPos = {
        x: Math.max(0, window.innerWidth - 36),
        y: Math.round(window.innerHeight * 0.58),
    };
    const pos = S().ballPos || defaultPos;
    const placed = placeBallAt(pos.x, pos.y, true);
    S().ballPos = placed;

    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let origX = 0;
    let origY = 0;

    ball.on('pointerdown', e => {
        dragging = true;
        moved = false;
        startX = e.clientX;
        startY = e.clientY;
        const rect = ball[0].getBoundingClientRect();
        origX = rect.left;
        origY = rect.top;
        ball.addClass('dragging');
        if (ball[0].setPointerCapture) {
            try { ball[0].setPointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
        }
    });

    ball.on('pointermove', e => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!moved && Math.abs(dx) + Math.abs(dy) > 6) moved = true;
        if (moved) {
            placeBallAt(origX + dx, origY + dy, false);
        }
    });

    ball.on('pointerup pointercancel', () => {
        if (!dragging) return;
        dragging = false;
        ball.removeClass('dragging');
        if (moved) {
            const rect = ball[0].getBoundingClientRect();
            S().ballPos = placeBallAt(rect.left, rect.top, true);
            saveSettingsDebounced();
        } else {
            openDrawer('main');
        }
    });
}

// ---------- 扩展页面 ----------
function createUI() {
    const html = `
    <div class="asw_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>${TITLE}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="asw-section">
                    <h4>添加新配置</h4>
                    <div class="flex-container flexFlowColumn flexGap5">
                        <input type="text" id="asw-name" class="text_pole" placeholder="配置名称 (例如: OpenAI GPT-4)">
                        <input type="text" id="asw-group" class="text_pole" placeholder="分组名称 (可选，例如: 工作用)">
                        <input type="text" id="asw-url" class="text_pole" placeholder="Custom API URL (例如: https://api.openai.com/v1)">
                        <input type="password" id="asw-key" class="text_pole" placeholder="Custom API密钥 (可选)">
                        <input type="text" id="asw-model" class="text_pole" placeholder="首选模型 (可选，例如: gpt-4)">
                        <select id="asw-model-select" class="text_pole"></select>
                        <div class="asw-btn-row">
                            <button id="asw-fetch" class="menu_button">获取模型</button>
                            <button id="asw-save" class="menu_button">保存配置</button>
                        </div>
                        <button id="asw-cancel" class="menu_button" style="display:none;">取消编辑</button>
                    </div>
                </div>
                <div class="asw-section">
                    <h4>已保存的配置</h4>
                    <div id="asw-list"></div>
                </div>
            </div>
        </div>
    </div>`;

    const form = $('#custom_form');
    if (form.length) {
        form.after(html);
    } else if ($('#extensions_settings').length) {
        $('#extensions_settings').append(html);
    } else if ($('#extensions_settings2').length) {
        $('#extensions_settings2').append(html);
    } else {
        console.error('[ASW] 找不到放置界面的位置');
    }
    resetModelSelect();
}

// ---------- 检查更新 ----------
function cmpVer(a, b) {
    const x = String(a).split('.').map(Number);
    const y = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] || 0) - (y[i] || 0);
        if (d) return d > 0 ? 1 : -1;
    }
    return 0;
}

function renderUpdateStatus() {
    const row = $('#asw-update-row');
    if (!row.length) return;
    const dot = row.find('.asw-status-dot');
    const text = row.find('.asw-status-text');
    const btn = row.find('#asw-update-action-btn');

    dot.removeClass('asw-dot-green asw-dot-red');
    if (!updateState.checked) {
        text.text('未检查');
        btn.text('检查更新').removeClass('asw-has-update');
        return;
    }

    if (updateState.hasUpdate) {
        dot.addClass('asw-dot-red');
        text.text(`有新版本 ${updateState.remote}`);
        btn.text('更新').addClass('asw-has-update');
    } else {
        dot.addClass('asw-dot-green');
        text.text('已是最新版本');
        btn.text('检查更新').removeClass('asw-has-update');
    }
}

async function getVersions() {
    const lr = await fetch(new URL('manifest.json', import.meta.url) + '?t=' + Date.now(), { cache: 'no-cache' });
    const local = await lr.json();
    const rr = await fetch(`https://raw.githubusercontent.com/${REPO}/main/manifest.json?t=${Date.now()}`, { cache: 'no-cache' });
    if (!rr.ok) throw new Error(`HTTP ${rr.status}`);
    const remote = await rr.json();
    return { local: local.version, remote: remote.version };
}

async function doUpdate() {
    try {
        const res = await fetch('/api/extensions/update', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ extensionName: FOLDER, global: true }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        toastr.success('更新完成', TITLE);
        if (confirm('更新完成，现在刷新页面吗？')) location.reload();
    } catch (e) {
        toastr.warning('自动更新失败，请在扩展页卸载后重新安装', TITLE);
    }
}

async function checkUpdate(manual) {
    try {
        const { local, remote } = await getVersions();
        updateState = {
            checked: true,
            hasUpdate: cmpVer(remote, local) > 0,
            local,
            remote,
        };
        renderUpdateStatus();
        if (manual && !updateState.hasUpdate) {
            toastr.info(`已是最新版本 ${local}`, TITLE);
        }
    } catch (e) {
        if (manual) toastr.error(`检查更新失败: ${e.message}`, TITLE);
    }
}

async function mountUpdateUI() {
    try {
        const r = await fetch(new URL('manifest.json', import.meta.url) + '?t=' + Date.now());
        currentVersion = (await r.json()).version || '';
    } catch (e) { /* 读不到就不显示 */ }

    const row = $('<div id="asw-update-row" class="asw-update-row">')
        .append(
            $('<div class="asw-update-left">')
                .append($('<span class="asw-ver">').text(currentVersion ? `v${currentVersion}` : ''))
                .append($('<span class="asw-status-dot">'))
                .append($('<span class="asw-status-text">').text('未检查'))
        )
        .append($('<button type="button" id="asw-update-action-btn" class="menu_button">').text('检查更新'));

    $('.asw_settings > .inline-drawer > .inline-drawer-content').prepend(row);
    renderUpdateStatus();

    setTimeout(() => checkUpdate(false), 6000);
}

// ---------- 事件绑定 ----------
function bindEvents() {
    $(document).on('click', '#asw-save', saveConfig);
    $(document).on('click', '#asw-cancel', clearForm);
    $(document).on('click', '#asw-fetch', fetchModels);

    $(document).on('change', '#asw-model-select', function () {
        const v = $(this).val();
        if (v) $('#asw-model').val(v);
    });

    $(document).on('click', '.asw-group-head', function () {
        const g = $(this).attr('data-group');
        S().collapsed[g] = !S().collapsed[g];
        saveSettingsDebounced();
        renderList();
    });

    $(document).on('click', '.asw-apply', async function () {
        const c = S().configs.find(x => x.id === $(this).attr('data-id'));
        if (c) await applyConfig(c);
    });
    $(document).on('click', '.asw-edit', function () { editConfig($(this).attr('data-id')); });
    $(document).on('click', '.asw-del', function () { deleteConfig($(this).attr('data-id')); });

    $(document).on('click', '#asw-update-action-btn', async function () {
        if (updateState.checked && updateState.hasUpdate) {
            await doUpdate();
        } else {
            await checkUpdate(true);
        }
    });

    // 魔法棒菜单入口与抽屉面板交互
    $(document).on('click', '#asw-wand-item', function () {
        $('#extensionsMenu').hide();
        openDrawer('main');
    });
    $(document).on('click', '#asw-drawer-backdrop, #asw-drawer-close', closeDrawer);
    $(document).on('click', '#asw-drawer-to-main', () => openDrawer('main'));
    $(document).on('click', '#asw-drawer-to-form', () => openDrawer('form'));
    $(document).on('click', '#asw-drawer-to-settings', () => openDrawer('settings'));

    $(document).on('click', '#asw-qd-save', function () {
        const name = $('#asw-qd-name').val().trim();
        const group = $('#asw-qd-group').val().trim();
        const url = $('#asw-qd-url').val().trim();
        const key = $('#asw-qd-key').val().trim();
        const model = $('#asw-qd-model').val().trim();
        if (!name) return toastr.error('请输入配置名称', TITLE);
        if (!url) return toastr.error('请输入API URL', TITLE);

        S().configs.push({ id: uid(), name, group, url, key, model });
        saveSettingsDebounced();
        $('#asw-qd-name, #asw-qd-group, #asw-qd-url, #asw-qd-key, #asw-qd-model').val('');
        toastr.success(`已保存: ${name}`, TITLE);
        renderList();
        openDrawer('main');
    });

    $(document).on('click', '.asw-drawer-apply', async function () {
        const c = S().configs.find(x => x.id === $(this).attr('data-id'));
        if (c) {
            closeDrawer();
            await applyConfig(c);
        }
    });

    $(document).on('click', '.asw-theme-btn', function () {
        const theme = $(this).attr('data-theme');
        if (!theme) return;
        S().theme = theme;
        saveSettingsDebounced();
        applyDrawerTheme();
    });

    $(document).on('change', '#asw-drawer-ball-toggle', function () {
        S().showBall = $(this).prop('checked');
        saveSettingsDebounced();
        syncFloatBall();
    });

    $(window).on('resize.aswBall', () => {
        if (!S().showBall || !S().ballPos) return;
        S().ballPos = placeBallAt(S().ballPos.x, S().ballPos.y, true);
    });
}

// ---------- 启动 ----------
jQuery(async () => {
    initSettings();
    createUI();
    createDrawerUI();
    mountUpdateUI();
    mountWandMenuEntry();
    bindEvents();
    renderList();
    syncFloatBall();

    setTimeout(() => {
        const s = S();
        if (!s.lastId) return;
        const c = s.configs.find(x => x.id === s.lastId);
        if (c) applyConfig(c, true);
    }, 3000);
});
