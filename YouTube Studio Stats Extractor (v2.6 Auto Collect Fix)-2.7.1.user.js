// ==UserScript==
// @name         YT Stats + GEO + Caches
// @namespace    http://tampermonkey.net/
// @version      2.9.4
// @description  Автозбір даних з Overview + Content, без рефакторингу робочих частин. Додає monetization, 4-й контейнер, Lifetime (3с), channelId.
// @match        https://studio.youtube.com/*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect script.google.com
// @connect script.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------- логування ----------
  const LOGP = '[YSE]';
  const dlog = (...a) => console.log(LOGP, ...a);
  const derr = (...a) => console.error(LOGP, ...a);

  // ---------- стан ----------
  let overviewChannel = '';
  let overviewDateUTC = '';
  let oViews48h = '';
  let oViewsPeriod = '';
  let oHoursPeriod = '';
  let oSubscribers = '';

  let contentDateUTC = '';
  let forceCollect = false;

  // додано за ТЗ
  let monetization = false;   // true якщо 4 блоки key-metric, false якщо 3
  let fourthMetric = '';      // текст #metric-total у 4-му контейнері (якщо є)
  let overviewChannelId = ''; // UC… з URL

  // секундомір очікування Content
  let contentWaitTimer = null;

  // ---------- утиліти ----------
  function getExtractButton() { return document.querySelector('#extract-button'); }
  function setButtonStatus(text) { const btn = getExtractButton(); if (btn) btn.textContent = text; }

  // Дата за часовим поясом Лос-Анджелеса у форматі YYYY-MM-DD
  function getDateInLA() {
    const laDate = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
    const d = new Date(laDate);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  const HEADER_SELECTORS = [
    '#right-section-content',
    'ytcp-header #right',
    'ytcp-header #right-section',
    'ytcp-header #right-container',
    '#right-section',
    '#right-content'
  ];
  function findHeaderContainer() {
    for (const q of HEADER_SELECTORS) { const el = document.querySelector(q); if (el) return el; }
    return null;
  }

  // === АВТО-СТАТУС ДЛЯ OMNISEARCH (залишаємо твою функцію правил) ===
  function computeAutoStatus({ monetizationFlag, views48h, hoursLifetime, subscribers, totalVideos }) {
    const v48 = Number(views48h) || 0;
    const hrs = Number(hoursLifetime) || 0;
    const subs = Number(subscribers) || 0;
    const vids = Number(totalVideos) || 0;

    // Монетні
    if (monetizationFlag) {
      if (v48 >= 15000) return 'Монета топ';
      if (v48 >= 10000) return 'Монета гуд';
      if (v48 >= 5000)  return 'Монета норм';
      if (v48 >= 2000)  return 'Монета ге';
      return 'Монета тінь';
    }

    // НЕ монетні
    if (hrs > 4000 && subs >= 500) return 'Чекаємо';
    if (hrs > 4000 && subs < 500)  return 'Підписки';
    if (v48 >= 10000)              return 'Топ';
    if (v48 >= 5000)               return 'Гуд';
    if (v48 > 2000 && v48 < 5000)  return 'Норм';
    if (hrs > 1000 && v48 <= 2000) return 'Тінь';

    // Розгалуження за кількістю відео при низьких v48
    if (vids >= 14 && v48 <= 2000 && vids < 20) return 'Пауза';
    if (vids > 20 && v48 <= 2000)               return 'Заміна';
    if (vids < 14 && v48 < 2000 && v48 > 100)   return 'Тестові';
    if (vids < 14 && v48 < 100)                 return 'Нулячі';

    // Фолбек
    return monetizationFlag ? 'Монета тінь' : 'Тінь';
  }

  // Старий API (якщо десь лишився) — залишимо як no-op-sync із плейсхолдером
  function setOmniSearchStatus(statusText) {
    try {
      const inp = document.querySelector('input#query-input');
      if (!inp) return;
      inp.setAttribute('placeholder', statusText);
      dlog('OmniSearch статус (placeholder):', statusText);
    } catch (e) {
      derr('setOmniSearchStatus error:', e);
    }
  }

  function ensureHeaderButton() {
    if (document.querySelector('#extract-button')) return;
    const container = findHeaderContainer();
    if (!container) return;
    const btn = document.createElement('button');
    btn.id = 'extract-button';
    btn.textContent = '📊 Дані';
    btn.style.cssText = `
      margin-left: 10px;
      background-color: #3ea6ff;
      color: white;
      border: none;
      padding: 6px 12px;
      font-weight: bold;
      border-radius: 4px;
      cursor: pointer;
    `;
    btn.addEventListener('click', onExtractClick);
    container.appendChild(btn);
    dlog('Кнопка "Дані" інжектована');
  }

  function waitForElement(selector, cb, timeoutMs = 25000, intervalMs = 200) {
    const start = Date.now();
    const iv = setInterval(() => {
      const el = document.querySelector(selector);
      if (el) { clearInterval(iv); dlog('wait OK:', selector); cb(el); }
      else if (Date.now() - start > timeoutMs) { clearInterval(iv); derr('wait TIMEOUT:', selector); }
    }, intervalMs);
  }

  function parseNumber(text) {
    const s = String(text || '').replace(/\u00A0/g, ' ').replace(/\s/g, '').replace(/,/g, '.');
    const m = s.match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : 0;
  }

  // Універсальний парсер з підтримкою тыс/млн/k/m + очистка валютних символів
  function parseNumberWithUnits(raw) {
    let text = String(raw || '')
      .replace(/\u00A0/g, ' ')
      .trim()
      .toLowerCase();

    text = text.replace(/[$₴€₽]/g, '').trim();

    const numMatch = text.replace(',', '.').match(/-?\d+(\.\d+)?/);
    let base = numMatch ? parseFloat(numMatch[0]) : NaN;
    if (isNaN(base)) return 0;

    if (/(тыс|тис|k)\.?/.test(text)) base *= 1000;
    if (/(млн|m)\.?/.test(text))     base *= 1_000_000;

    return base;
  }

  /* === OmniSearch Status (drop-in, stable singleton, no overlay) ============== */
  let yseDesiredStatusText = '';   // що показувати
  let yseStatusBoxRef = null;      // <div id="yse-status-box">
  let yseSearchLayerRef = null;    // div#search-layer…
  let yseLayerObserver = null;     // єдиний observer

  (function injectYseBadgeStyles() {
    if (document.getElementById('yse-badge-styles')) return;
    const css = `
      .yse-badge-search {
        display:flex; align-items:center; width:100%; box-sizing:border-box;
        padding:0 12px; height:40px; border-radius:24px;
        background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12);
        font-weight:500; font-size:14px; line-height:1; justify-content:center;
      }
      .yse-chip{display:inline-flex;align-items:center;justify-content:center;
        padding:6px 0;border-radius:999px;font-weight:600;border:1px solid transparent;width:100%;}
      .yse-chip-green{color:#22c55e;background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.25)}
      .yse-chip-orange{color:#f59e0b;background:rgba(245,158,11,.12);border-color:rgba(245,158,11,.25)}
      .yse-chip-blue{color:#3b82f6;background:rgba(59,130,246,.12);border-color:rgba(59,130,246,.25)}
      .yse-chip-red{color:#ef4444;background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.25)}
      .yse-chip-gray{color:#9ca3af;background:rgba(156,163,175,.12);border-color:rgba(156,163,175,.25)}
      .yse-badge-search.yse-no-bg{background:transparent!important;border:none!important}
    `;
    const style = document.createElement('style');
    style.id = 'yse-badge-styles';
    style.textContent = css;
    document.head.appendChild(style);
  })();

  function yseCloseOmniOverlays() {
    try {
      document.querySelectorAll('tp-yt-iron-overlay-backdrop.opened')
        .forEach(el => { try { el.remove(); } catch(_){} });
      document.querySelectorAll('ytcp-text-menu[opened], ytcp-dialog[opened], .style-scope.ytcp-omnisearch[opened]')
        .forEach(el => { try { el.removeAttribute('opened'); el.style.display='none'; } catch(_){} });
      const inp = document.querySelector('input#query-input');
      if (inp && document.activeElement === inp) { try { inp.blur(); } catch(_){} }
      document.querySelectorAll('[aria-expanded="true"]')
        .forEach(el => { try { el.setAttribute('aria-expanded','false'); } catch(_){} });
    } catch(_) {}
  }
  function yseFindSearchLayer() {
    return document.querySelector('div#search-layer.style-scope.ytcp-omnisearch') || null;
  }
  function yseApplyBoxLookFromLayer(layer, box) {
    try {
      if (!layer || !box) return;
      const cs = getComputedStyle(layer);
      if (cs) {
        if (cs.height) box.style.height = cs.height;
        if (cs.borderRadius) box.style.borderRadius = cs.borderRadius;
        if (cs.padding) box.style.padding = cs.padding;
        if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0,0,0,0)') box.style.background = cs.backgroundColor;
        if (cs.border && cs.border !== '0px none rgb(0,0,0)') box.style.border = cs.border;
      }
      const inp = layer.querySelector('input, #query-input');
      if (inp) {
        const ci = getComputedStyle(inp);
        if (ci.height) box.style.height = ci.height;
        if (ci.borderRadius) box.style.borderRadius = ci.borderRadius;
        if (ci.padding) box.style.padding = ci.padding;
        if (ci.fontSize) box.style.fontSize = ci.fontSize;
        if (ci.lineHeight) box.style.lineHeight = ci.lineHeight;
      }
    } catch(_) {}
  }
  function yseGetStatusColorClass(statusText='') {
    const s = String(statusText).toLowerCase();
    if (s.includes('топ')) return 'yse-green';
    if (s.includes('гуд')) return 'yse-orange';
    if (s.includes('норм')) return 'yse-blue';
    if (s.includes('заміна') || s.includes('тінь')) return 'yse-red';
    if (s.includes('нуляч')) return 'yse-gray';
    return 'yse-blue';
  }
  function yseGetStatusChipClass(statusText='') {
    try { return yseGetStatusColorClass(statusText).replace(/^yse-/,'yse-chip-'); }
    catch { return 'yse-chip-blue'; }
  }
  function yseRenderChipText(txt) {
    if (!yseStatusBoxRef) return;
    const cls = yseGetStatusChipClass(txt);
    let chip = yseStatusBoxRef.querySelector('.yse-chip');
    if (!chip) {
      chip = document.createElement('span');
      chip.className = `yse-chip ${cls}`;
      yseStatusBoxRef.appendChild(chip);
    }
    chip.className = `yse-chip ${cls}`;
    chip.textContent = txt;
  }
  function yseEnsureBadgeMounted() {
    if (!yseSearchLayerRef || !document.contains(yseSearchLayerRef)) {
      yseSearchLayerRef = yseFindSearchLayer();
      if (!yseSearchLayerRef) return;
    }
    Array.from(yseSearchLayerRef.childNodes || []).forEach((n) => {
      if (n && n !== yseStatusBoxRef && n.style) n.style.display = 'none';
    });
    if (!yseStatusBoxRef || !yseSearchLayerRef.contains(yseStatusBoxRef)) {
      yseStatusBoxRef = yseSearchLayerRef.querySelector('#yse-status-box');
      if (!yseStatusBoxRef) {
        const box = document.createElement('div');
        box.id = 'yse-status-box';
        box.className = 'yse-badge-search';
        yseStatusBoxRef = box;
        yseApplyBoxLookFromLayer(yseSearchLayerRef, yseStatusBoxRef);
        yseSearchLayerRef.appendChild(box);
      }
    }
    yseRenderChipText(yseDesiredStatusText || '');
    if (yseStatusBoxRef) yseStatusBoxRef.classList.add('yse-no-bg');

    if (!yseLayerObserver) {
      yseLayerObserver = new MutationObserver(() => { yseEnsureBadgeMounted(); });
      yseLayerObserver.observe(yseSearchLayerRef, { childList: true, subtree: false });
    }
    yseCloseOmniOverlays();
  }
  function setOmniSearchBadge(statusText) {
    try {
      yseDesiredStatusText = String(statusText || '').trim();
      yseEnsureBadgeMounted();
      let tries = 0;
      const iv = setInterval(() => {
        if (++tries > 40) { clearInterval(iv); return; }
        if (yseFindSearchLayer()) { yseEnsureBadgeMounted(); clearInterval(iv); }
      }, 500);
      const inp = document.querySelector('input#query-input');
      if (inp) inp.setAttribute('placeholder', yseDesiredStatusText);
    } catch (e) {
      try { console.error('[YSE] setOmniSearchBadge error:', e); } catch(_) {}
    }
  }
  function yseInitStatusBadge() {
    try { yseEnsureBadgeMounted(); yseCloseOmniOverlays(); } catch(_) {}
  }
  yseInitStatusBadge();
  window.addEventListener('load', yseInitStatusBadge);
  setTimeout(yseInitStatusBadge, 1500);
  setInterval(() => { if (yseFindSearchLayer()) yseEnsureBadgeMounted(); }, 3000);
  /* === /OmniSearch Status ===================================================== */

  // ---------- Status Cache (пер-канальний) ----------
  const STATUS_CACHE_LS_KEY = 'yse_status_cache_v1';
  function statusCacheLoad() {
    try {
      const raw = localStorage.getItem(STATUS_CACHE_LS_KEY);
      const json = raw ? JSON.parse(raw) : {};
      return (json && typeof json === 'object') ? json : {};
    } catch (_) { return {}; }
  }
  function statusCacheSave(map) { try { localStorage.setItem(STATUS_CACHE_LS_KEY, JSON.stringify(map || {})); } catch (_) {} }
  function statusCacheGet(channelId) { if (!channelId) return null; const map = statusCacheLoad(); return map[channelId]?.status || null; }
  function statusCacheSet(channelId, statusText) {
    if (!channelId) return;
    const map = statusCacheLoad();
    map[channelId] = { status: String(statusText || '').trim(), ts: Date.now() };
    statusCacheSave(map);
  }
  function getChannelIdFromUrl() { return (location.href.match(/\/channel\/([^/]+)/)?.[1]) || ''; }
  function showCachedStatusForCurrentChannel() {
    const cid = getChannelIdFromUrl();
    const cached = statusCacheGet(cid);
    if (cached) {
      setOmniSearchBadge(cached);
      dlog('Cached status shown:', cached);
    }
  }
  function setTemporaryParsingStatus() {
    const temp = 'очікування парсингу…';
    setOmniSearchBadge(temp);
  }

  // ---------- прибирання "Вийти" ----------
  function removeSignOutMenuItem() {
    try {
      const link = document.querySelector(
        'ytd-compact-link-renderer a[href*="/logout"], ' +
        'a[href^="https://www.youtube.com/logout"], ' +
        'a[href^="https://accounts.google.com/Logout"]'
      );
      if (link) {
        const parentItem = link.closest('ytd-compact-link-renderer, tp-yt-paper-item');
        if (parentItem) {
          parentItem.remove();
          dlog('Прибрано пункт "Вийти"');
        }
      }
    } catch (e) {
      derr('removeSignOutMenuItem error:', e);
    }
  }

  // ---------- навігаційні кліки ----------
  function clickAnalyticsTab(done) {
    dlog('Відкриваємо Аналітику (клік)…');
    const tryClick = () => {
      const el =
        document.querySelector('a[title*="Аналитика"], a[title*="Analytics"], a[href*="/analytics"]') ||
        document.querySelector('#menu-paper-icon-item-2');
      if (el) {
        el.click();
        waitForElement('.metric-value.style-scope.yta-latest-activity-card', () => {
          dlog('Аналітика відкрита');
          if (typeof done === 'function') done();
        }, 25000);
        return true;
      }
      return false;
    };
    if (!tryClick()) {
      waitForElement('ytd-app, ytcp-header', () => { tryClick(); }, 20000);
    }
  }

  function clickContentTab() {
    waitForElement('#content', (contentTab) => {
      contentTab.click();
      dlog('Клік по #content виконано, чекаємо приховання #right-side-bar…');

      try {
        if (contentWaitTimer) { clearInterval(contentWaitTimer); contentWaitTimer = null; }
        let secs = 0;
        setButtonStatus(`⏱️ Контент ${secs}с`);
        contentWaitTimer = setInterval(() => {
          secs += 1;
          setButtonStatus(`⏱️ Контент ${secs}с`);
        }, 1000);
      } catch (e) { /* no-op */ }

      const start = Date.now();
      const iv = setInterval(() => {
        const el = document.querySelector('#right-side-bar');
        if (el && el.style.display === 'none') {
          clearInterval(iv);
          if (contentWaitTimer) { clearInterval(contentWaitTimer); contentWaitTimer = null; }
          dlog('#right-side-bar приховано, парсимо Content');
          extractContentDataAndSend();
        } else if (Date.now() - start > 20000) {
          clearInterval(iv);
          if (contentWaitTimer) { clearInterval(contentWaitTimer); contentWaitTimer = null; }
          derr('Не дочекалися приховування #right-side-bar, викликаю fallback');
          extractContentDataAndSend();
        }
      }, 200);
    });
  }

  // ---------- основний флоу ----------
  function onExtractClick() {
    try {
      dlog('Клік по кнопці "Дані"');
      setButtonStatus('🔄 Починаю…');
      setTemporaryParsingStatus();           // 🆕 одразу ставимо очікування
      forceCollect = true;
      removeSignOutMenuItem();

      overviewChannelId = (location.href.match(/\/channel\/([^/]+)/)?.[1]) || '';
      dlog('channelId:', overviewChannelId || '(не знайдено)');

      clickAnalyticsTab(() => {
        extractOverviewData(() => {
          clickContentTab(() => {
            extractContentDataAndSend();
          });
        });
      });
    } catch (e) {
      derr('onExtractClick error:', e);
      setButtonStatus('❌ Помилка');
    }
  }

  // >>> Відкриття періоду → Lifetime → 3с → парсинг Overview
  function extractOverviewData(callback) {
    try {
      dlog('Відкриваємо період і обираємо Lifetime…');
      waitForElement('div[role="button"].has-label.borderless.container.style-scope.ytcp-dropdown-trigger', (periodBtn) => {
        try {
          periodBtn.click();
          waitForElement('[test-id="lifetime"]', (lifeItem) => {
            lifeItem.click();
            dlog('Lifetime натиснуто, очікуємо 3с…');

            setTimeout(() => {
              waitForElement('.metric-value.style-scope.yta-latest-activity-card', () => {
                try {
                  const metricElems = document.querySelectorAll('.metric-value.style-scope.yta-latest-activity-card');
                  const subscribers = parseNumber(metricElems[0]?.textContent || '0');
                  const views48h = parseNumber(metricElems[1]?.textContent || '0');

                  const totals = Array.from(document.querySelectorAll('#metric-total')).map(el => (el.textContent || '').trim());
                  const viewsPeriod = parseNumberWithUnits(totals[0] || '0');
                  const hoursPeriod = parseNumberWithUnits(totals[1] || '0');

                  overviewChannel = document.querySelector('#entity-name.entity-name')?.textContent.trim() || 'Без назви';
                  overviewDateUTC = getDateInLA();
                  oViews48h = views48h;
                  oViewsPeriod = viewsPeriod;
                  oHoursPeriod = hoursPeriod;
                  oSubscribers = subscribers;

                  const blocks = document.querySelectorAll('div#container.layout.vertical.style-scope.yta-key-metric-block');
                  monetization = (blocks.length === 4);
                  if (blocks[3]) {
                    const m = blocks[3].querySelector('#metric-total');
                    let val = (m?.textContent || blocks[3].innerText || '').trim();
                    fourthMetric = String(parseNumberWithUnits(val));
                  } else {
                    fourthMetric = '0';
                  }

                  dlog('Overview OK (normalized):', { overviewChannel, oSubscribers, oViews48h, oViewsPeriod, oHoursPeriod, monetization, fourthMetric });
                  setButtonStatus('✅ Загальна');
                  if (typeof callback === 'function') callback();
                } catch (e) {
                  derr('extractOverviewData parse error:', e);
                  setButtonStatus('❌ Помилка');
                }
              });
            }, 3000);
          });
        } catch (e) {
          derr('extractOverviewData period click error (fallback без Lifetime):', e);
          waitForElement('.metric-value.style-scope.yta-latest-activity-card', () => {
            try {
              const metricElems = document.querySelectorAll('.metric-value.style-scope.yta-latest-activity-card');
              const subscribers = parseNumber(metricElems[0]?.textContent || '0');
              const views48h = parseNumber(metricElems[1]?.textContent || '0');

              const totals = Array.from(document.querySelectorAll('#metric-total')).map(el => (el.textContent || '').trim());
              const viewsPeriod = parseNumberWithUnits(totals[0] || '0');
              const hoursPeriod = parseNumberWithUnits(totals[1] || '0');

              overviewChannel = document.querySelector('#entity-name.entity-name')?.textContent.trim() || 'Без назви';
              overviewDateUTC = getDateInLA();
              oViews48h = views48h;
              oViewsPeriod = viewsPeriod;
              oHoursPeriod = hoursPeriod;
              oSubscribers = subscribers;

              const blocks = document.querySelectorAll('div#container.layout.vertical.style-scope.yta-key-metric-block');
              monetization = (blocks.length === 4);
              if (blocks[3]) {
                const m = blocks[3].querySelector('#metric-total');
                let val = (m?.textContent || blocks[3].innerText || '').trim();
                fourthMetric = String(parseNumberWithUnits(val));
              } else {
                fourthMetric = '0';
              }

              dlog('Overview Fallback OK (normalized):', { monetization, fourthMetric });
              setButtonStatus('✅ Загальна');
              if (typeof callback === 'function') callback();
            } catch (e2) {
              derr('extractOverviewData fallback parse error:', e2);
              setButtonStatus('❌ Помилка');
            }
          });
        }
      });
    } catch (e) {
      derr('extractOverviewData outer error:', e);
      setButtonStatus('❌ Помилка');
    }
  }

  // ---------- CONTENT ----------
  function extractContentDataAndSend() {
    try {
      if (contentWaitTimer) { clearInterval(contentWaitTimer); contentWaitTimer = null; }

      const totals = Array.from(document.querySelectorAll('#metric-total'))
        .map(el => (el.textContent || '').trim());

      const impressions = parseNumberWithUnits(totals[1] || '0');

      const ctrText = (totals[2] || '').replace(/\u00A0/g, ' ').trim().toLowerCase();
      const ctrNumMatch = ctrText.replace(',', '.').match(/-?\d+(\.\d+)?/);
      const ctr = ctrNumMatch ? `${(+ctrNumMatch[0]).toFixed(/[.,]\d/.test(ctrText) ? 1 : 0)}%` : '';

      const avgRaw = (totals[3] || '').trim();
      const avgViewDuration = /^\d{1,2}:[0-5]\d$/.test(avgRaw) ? avgRaw : avgRaw;

      contentDateUTC = getDateInLA();
      const contentMetrics = { impressions, ctr, avgViewDuration };

      dlog('Content metrics (normalized):', contentMetrics);
      setButtonStatus('✅ Контент');
      goToVideosAndExtractCount(contentMetrics);
    } catch (e) {
      derr('extractContentDataAndSend error:', e);
      setButtonStatus('❌ Помилка');
    }
  }

  function goToVideosAndExtractCount(contentMetrics) {
    dlog('Відкриваємо головне меню "Контент" (клік)…');

    const candidates = [
      '#menu-paper-icon-item-1',
      'a[title*="Контент"]',
      'a[title*="Content"]',
      'a[href*="/content"]',
      'a[href*="/videos"]',
      '#content'
    ];

    const clickEl = (el) => {
      try {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      } catch (e) {
        derr('Помилка кліку по пункту меню "Контент":', e);
        return false;
      }
    };

    let clicked = false;
    const startFind = Date.now();
    const findIv = setInterval(() => {
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el && clickEl(el)) {
          dlog('Клік по пункту меню "Контент":', sel);
          clicked = true;
          clearInterval(findIv);
          waitForUrlThenParse();
          return;
        }
      }
      if (Date.now() - startFind > 15000) {
        clearInterval(findIv);
        dlog('Не знайшов пункт "Контент" за 15с — продовжую фолбеком очікування URL…');
        waitForUrlThenParse();
      }
    }, 250);

    function waitForUrlThenParse() {
      const t0 = Date.now();
      const urlIv = setInterval(() => {
        const p = location.pathname;
        if (p.includes('/content') || p.includes('/videos')) {
          clearInterval(urlIv);
          dlog('URL = сторінка Контент, одразу читаємо кількість (без 3с)…');
          readTotalAndSend();
        } else if (Date.now() - t0 > 15000) {
          clearInterval(urlIv);
          dlog('Не дочекались переходу на /content|/videos за 15с (fallback). Читаємо одразу…');
          readTotalAndSend();
        }
      }, 200);
    }

    function readTotalAndSend() {
      try {
        waitForElement('.page-description', () => {
          const el = document.querySelector('.page-description');
          const rawText = el?.textContent || '';
          const match = rawText.match(/(?:из|of|з)\s*(?:примерно|approximately)?\s*(\d+)/i);
          const total = match ? parseInt(match[1].replace(/\s/g, ''), 10) : NaN;

          if (isNaN(total)) { derr('Не вдалося визначити total з .page-description'); return; }

          const combinedData =
            `${overviewChannel};${overviewDateUTC};${oSubscribers};${oViewsPeriod};${oHoursPeriod};${oViews48h};${overviewChannel};` +
            `${contentMetrics.impressions};${contentMetrics.ctr}${'\u200B'};${contentMetrics.avgViewDuration}${'\u200B'};${contentDateUTC};${total}` +
            `;${monetization};${fourthMetric};${overviewChannelId}`;

          // 🆕 Авто-статус + кеш
          const autoStatus = computeAutoStatus({
            monetizationFlag: monetization,
            views48h: oViews48h,
            hoursLifetime: oHoursPeriod,
            subscribers: oSubscribers,
            totalVideos: total
          });
          setOmniSearchBadge(autoStatus);
          statusCacheSet(overviewChannelId || getChannelIdFromUrl(), autoStatus);

          dlog('Відправляємо:', combinedData);
          setButtonStatus('✉️ Відправка');
          sendToSheet(combinedData, 'combined');
          setButtonStatus('✅ Готово');
        }, 20000);
      } catch (e) {
        derr('readTotalAndSend error:', e);
        setButtonStatus('❌ Помилка');
      }
    }
  }

  // ---------- відправка ----------
  function sendToSheet(value, mode) {
    GM_xmlhttpRequest({
      method: 'POST',
      url: 'https://script.google.com/macros/s/AKfycbyd0aMl6ZomWyWtNbzxMikqfYVq2RTArD0z97eyVaWWa3zDeLOk0qALtIkiseI393lS/exec',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ mode: mode, value: value })
    });
  }

  // ---------- ініціалізація ----------
  const obs = new MutationObserver(() => ensureHeaderButton());
  obs.observe(document.documentElement, { childList: true, subtree: true });
  ensureHeaderButton();

  const keepBtnAliveIv = setInterval(() => {
    if (!getExtractButton()) ensureHeaderButton();
  }, 1000);

  const signOutObserver = new MutationObserver(() => removeSignOutMenuItem());
  signOutObserver.observe(document.body, { childList: true, subtree: true });
  removeSignOutMenuItem();

  // показати кешований статус одразу
  showCachedStatusForCurrentChannel();

  dlog('Script ready');

 /* === GeoBadge add-on (Google Sheet overrides + CACHE) =======================
   Логіка:
   1) Підняти кеш із localStorage → миттєвий рендер.
   2) Якщо для каналу немає GEO у кеші → один раз оновити кеш із таблиці і повторити.
   3) Якщо і після оновлення немає → показати "пауза".
============================================================================= */

const GEO_OVERRIDES_URL = "https://script.google.com/macros/s/AKfycbzqSQtJJp3gL5y2R3c3ABWx-aWcG8U9jcF_k-WOjdAfFclJ3OREtJcU4rEEs2snYV1K/exec";
const GEO_CACHE_LS_KEY  = "yse_geo_cache_v2"; // bump при зміні формату

let geoMap = Object.create(null);     // { normalizedName: "Україна", ... }
let overridesReady = false;
let overridesLoading = false;
let overridesWaiters = [];            // колбеки, які чекають завершення завантаження

function normalizeName(s) {
  return String(s || "")
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

// ---- CACHE (localStorage) ----
function loadCacheFromLS() {
  try {
    const raw = localStorage.getItem(GEO_CACHE_LS_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.map) return false;
    geoMap = parsed.map || Object.create(null);
    overridesReady = true;
    console.log("[YSE] GEO cache restored:", Object.keys(geoMap).length);
    return true;
  } catch (_) { return false; }
}

function saveCacheToLS() {
  try {
    localStorage.setItem(
      GEO_CACHE_LS_KEY,
      JSON.stringify({ ts: Date.now(), map: geoMap })
    );
  } catch (_) {}
}

// ---- NETWORK LOAD (повне оновлення) ----
function loadGeoOverrides(cb) {
  // якщо вже вантажимо — стаємо в чергу
  if (overridesLoading) { if (cb) overridesWaiters.push(cb); return; }
  overridesLoading = true;

  GM_xmlhttpRequest({
    method: "GET",
    url: GEO_OVERRIDES_URL,
    onload: (res) => {
      try {
        const json = JSON.parse(res.responseText || "{}");
        if (json && json.ok && Array.isArray(json.data)) {
          const next = Object.create(null);
          for (const row of json.data) {
            const name = normalizeName(row.channelName);
            if (name && row.geoLabel) next[name] = String(row.geoLabel).trim();
          }
          geoMap = next;
          overridesReady = true;
          saveCacheToLS();
          console.log("[YSE] GEO overrides loaded:", Object.keys(geoMap).length);
        } else {
          console.warn("[YSE] GEO overrides: unexpected response");
        }
      } catch (e) {
        console.error("[YSE] GEO overrides parse error:", e);
      } finally {
        overridesLoading = false;
        (overridesWaiters.splice(0) || []).forEach(fn => { try { fn(); } catch(_) {} });
        cb && cb();
      }
    },
    onerror: () => {
      overridesLoading = false;
      (overridesWaiters.splice(0) || []).forEach(fn => { try { fn(); } catch(_) {} });
      cb && cb();
    }
  });
}

// ---- Мапа GEO → прапор ----
const GEO_FLAGS = {
  "Японія": "🇯🇵", "Польща": "🇵🇱", "Німеччина": "🇩🇪", "Арабія": "🇸🇦", "Нідерланди": "🇳🇱",
  "Іспанія": "🇪🇸", "Ру": "🇷🇺", "Туреччина": "🇹🇷", "Португалія": "🇵🇹", "Італія": "🇮🇹",
  "Китай": "🇨🇳", "Корея": "🇰🇷", "Румунія": "🇷🇴", "Греція": "🇬🇷", "Україна": "🇺🇦",
  "Індонезія": "🇮🇩", "Угорщина": "🇭🇺", "США": "🇺🇸", "Індія": "🇮🇳", "Фінляндія": "🇫🇮",
  "Ізраїль": "🇮🇱", "Норвегія": "🇳🇴", "Малайзія": "🇲🇾", "Швеція": "🇸🇪", "Франція": "🇫🇷",
  "Чехія": "🇨🇿", "Філіпіни": "🇵🇭", "Сербія": "🇷🇸", "Тайланд": "🇹🇭", "Данія": "🇩🇰"
};
function flagForGeo(label) { return GEO_FLAGS[label] || ""; }

// ---- Styles ----
(function injectGeoStyles(){
  if(document.getElementById('yse-geo-inline-after')) return;
  const style=document.createElement('style');
  style.id='yse-geo-inline-after';
  style.textContent = `
    yt-formatted-string#channel-title,
    ytd-account-item-renderer #channel-title,
    #entity-name.entity-name {
      display:inline-block !important;
      position:relative !important;
      width:auto !important;
      max-width:none !important;
      white-space:nowrap !important;
      vertical-align:baseline !important;
    }
    yt-formatted-string#channel-title[data-geo-label]::after,
    ytd-account-item-renderer #channel-title[data-geo-label]::after,
    #entity-name.entity-name[data-geo-label]::after {
      content: " " attr(data-geo-label);
      font:500 11px/1.2 Roboto,Arial,sans-serif;
      white-space:nowrap;
      opacity:.85;
      margin-left:6px;
    }
    .yse-geo-float {
      position:absolute; left:100%; top:0;
      margin-left:6px;
      font:500 11px/1.2 Roboto,Arial,sans-serif;
      white-space:nowrap; opacity:.85;
      pointer-events:none;
      transform: translateY(0.06em);
    }
  `;
  document.head.appendChild(style);
})();

// ---- Рендер ----
function setInlineAfterLabel(el, geoText) {
  if (!el) return;
  const text = `${flagForGeo(geoText)} ${geoText}`;
  el.setAttribute('data-geo-label', text);

  let afterContent = '';
  try { afterContent = window.getComputedStyle(el, '::after').getPropertyValue('content'); } catch {}
  const visible = afterContent && afterContent !== 'none' && afterContent.replace(/["']/g,'').trim().length>0;

  if (!visible) {
    let float = el.parentNode && el.parentNode.querySelector(':scope > .yse-geo-float');
    if (!float) {
      float = document.createElement('span');
      float.className = 'yse-geo-float';
      el.parentNode && el.parentNode.insertBefore(float, el.nextSibling);
    }
    float.textContent = text;
  } else {
    const sib = el.parentNode && el.parentNode.querySelector(':scope > .yse-geo-float');
    if (sib) try { sib.remove(); } catch {}
  }
}

// ---- Пошук у кеші з автооновленням при промаху ----
function ensureGeoForName(normName, cb) {
  if (geoMap[normName]) { cb(geoMap[normName]); return; }
  loadGeoOverrides(() => cb(geoMap[normName] || 'пауза'));
}

function renderOne(el) {
  if (!el) return;
  const name = (el.textContent || '').trim();
  const norm = normalizeName(name);
  ensureGeoForName(norm, (geo) => setInlineAfterLabel(el, geo));
}

function renderAccountList() {
  document.querySelectorAll('ytd-account-item-renderer #channel-title, yt-formatted-string#channel-title')
    .forEach(renderOne);
}

function renderDrawer() {
  const el = document.querySelector('#entity-name.entity-name');
  if (el) renderOne(el);
}

function initRenderers() {
  renderAccountList();
  renderDrawer();
}

// 1) Миттєво підняти кеш із LS
loadCacheFromLS();
initRenderers();

// 2) Паралельно оновити повний кеш із Google Sheet (свіжість)
loadGeoOverrides(() => { initRenderers(); });

// 3) Спостерігачі за DOM
const moTargets=[document.body, document.querySelector('ytd-app')||document.documentElement].filter(Boolean);
const geoMo=new MutationObserver(()=>initRenderers());
moTargets.forEach(t=>geoMo.observe(t,{childList:true,subtree:true}));
setInterval(initRenderers, 3500);

console.log("[YSE] GeoBadge ready (cached)");

})();
