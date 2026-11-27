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
let editingId = null;
let fetchKeyCache = { value: '', id: null };

function S() { return extension_settings[MODULE]; }

function initSettings() {
    if (!extension_settings[MODULE]) extension_settings[MODULE] = {};
    const s = extension_settings[MODULE];
    if (!Array.isArray(s.configs)) s.configs = [];
    if (!s.collapsed) s.collapsed = {};
    if (s.autoConnect === undefined) s.autoConnect = true;
    if (s.showBall === undefined) s.showBall = true;
    if (s.lastId === undefined) s.lastId = null;
}

function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
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

        // 连接后酒馆可能会重置模型，隔一会再设一次
        if (cfg.model) {
            setTimeout(() => setModel(cfg.model), 2000);
            setTimeout(() => setModel(cfg.model), 5000);
        }

        if (!quiet) toastr.success(`正在连接: ${cfg.name}`, TITLE);
        renderList();
    } catch (e) {
        console.error('[ASW] 应用失败', e);
        toastr.error(`应用失败: ${e.message}`, TITLE);
    }
}

// ---------- 获取模型 ----------
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
        sel.show();
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
    $('#asw-model-select').hide();
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
}

function editConfig(id) {
    const c = S().configs.find(x => x.id === id);
    if (!c) return;
    $('#asw-name').val(c.name);
    $('#asw-group').val(c.group || '');
    $('#asw-url').val(c.url || '');
    $('#asw-key').val(c.key || '');
    $('#asw-model').val(c.model || '');
    $('#asw-model-select').hide();
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
}

// ---------- 列表 ----------
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

// ---------- 悬浮球 ----------
function renderMenu() {
    const menu = $('#asw-menu').empty();
    const cfgs = S().configs;
    if (!cfgs.length) {
        menu.append($('<div class="asw-menu-empty">').text('还没有保存的配置'));
        return;
    }
    cfgs.forEach(c => {
        const row = $('<div class="asw-menu-item">').attr('data-id', c.id).toggleClass('asw-current', c.id === S().lastId);
        row.append($('<span class="asw-menu-name">').text(c.name));
        if (c.group) row.append($('<span class="asw-menu-group">').text(c.group));
        menu.append(row);
    });
}

function placeBall(x, y) {
    const ball = $('#asw-ball');
    const w = ball.outerWidth() || 44;
    const h = ball.outerHeight() || 44;
    const nx = Math.max(0, Math.min(window.innerWidth - w, x));
    const ny = Math.max(0, Math.min(window.innerHeight - h, y));
    ball.css({ left: nx + 'px', top: ny + 'px' });
    return { x: nx, y: ny };
}

function openMenu() {
    renderMenu();
    const ball = $('#asw-ball');
    const menu = $('#asw-menu');
    const r = ball[0].getBoundingClientRect();
    menu.css({ visibility: 'hidden' }).show();
    const mw = menu.outerWidth();
    const mh = menu.outerHeight();
    let left = Math.min(Math.max(8, r.left), window.innerWidth - mw - 8);
    let top = r.bottom + 8;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 8);
    menu.css({ left: left + 'px', top: top + 'px', visibility: 'visible' });
}

function buildBall() {
    $('#asw-ball, #asw-menu').remove();
    $(document).off('pointerdown.asw');
    if (!S().showBall) return;

    const ball = $('<div id="asw-ball" title="切换API"><i class="fa-solid fa-plug"></i></div>')
        .css({ position: 'fixed', 'touch-action': 'none', 'z-index': 99999 })
        .appendTo('body');
    $('<div id="asw-menu"></div>')
        .css({ position: 'fixed', 'z-index': 99999 })
        .hide()
        .appendTo('body');

    const pos = S().ballPos || { x: window.innerWidth - 60, y: Math.round(window.innerHeight * 0.6) };
    placeBall(pos.x, pos.y);

    let startX = 0, startY = 0, origX = 0, origY = 0, moved = false, dragging = false;

    ball.on('pointerdown', e => {
        dragging = true;
        moved = false;
        startX = e.clientX;
        startY = e.clientY;
        const r = ball[0].getBoundingClientRect();
        origX = r.left;
        origY = r.top;
        ball[0].setPointerCapture(e.pointerId);
    });
    ball.on('pointermove', e => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!moved && Math.abs(dx) + Math.abs(dy) > 6) moved = true;
        if (moved) {
            $('#asw-menu').hide();
            placeBall(origX + dx, origY + dy);
        }
    });
    ball.on('pointerup pointercancel', () => {
        if (!dragging) return;
        dragging = false;
        if (moved) {
            const r = ball[0].getBoundingClientRect();
            S().ballPos = { x: r.left, y: r.top };
            saveSettingsDebounced();
        } else if ($('#asw-menu').is(':visible')) {
            $('#asw-menu').hide();
        } else {
            openMenu();
        }
    });

    $('#asw-menu').on('click', '.asw-menu-item', async function () {
        const c = S().configs.find(x => x.id === $(this).attr('data-id'));
        $('#asw-menu').hide();
        if (c) await applyConfig(c);
    });

    $(document).on('pointerdown.asw', e => {
        if (!$(e.target).closest('#asw-ball, #asw-menu').length) $('#asw-menu').hide();
    });
}

// ---------- 界面 ----------
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
                        <button id="asw-fetch" class="menu_button">获取模型</button>
                        <select id="asw-model-select" class="text_pole" style="display:none;"></select>
                        <button id="asw-save" class="menu_button">保存配置</button>
                        <button id="asw-cancel" class="menu_button" style="display:none;">取消编辑</button>
                    </div>
                </div>
                <div class="asw-section">
                    <h4>选项</h4>
                    <label class="checkbox_label"><input type="checkbox" id="asw-auto"><span>启动时自动连接上次用的配置</span></label>
                    <label class="checkbox_label"><input type="checkbox" id="asw-ball-toggle"><span>显示悬浮球</span></label>
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
    $('#asw-auto').prop('checked', !!S().autoConnect);
    $('#asw-ball-toggle').prop('checked', !!S().showBall);
}

function bindEvents() {
    $(document).on('click', '#asw-save', saveConfig);
    $(document).on('click', '#asw-cancel', clearForm);
    $(document).on('click', '#asw-fetch', fetchModels);

    $(document).on('change', '#asw-model-select', function () {
        const v = $(this).val();
        if (v) $('#asw-model').val(v);
    });

    $(document).on('change', '#asw-auto', function () {
        S().autoConnect = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $(document).on('change', '#asw-ball-toggle', function () {
        S().showBall = $(this).prop('checked');
        saveSettingsDebounced();
        buildBall();
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
}

// ---------- 启动 ----------
jQuery(async () => {
    initSettings();
    createUI();
    bindEvents();
    renderList();
    buildBall();

    setTimeout(() => {
        const s = S();
        if (!s.autoConnect || !s.lastId) return;
        const c = s.configs.find(x => x.id === s.lastId);
        if (c) applyConfig(c, true);
    }, 3000);
});
