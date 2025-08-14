// ==UserScript==
// @name         YouTube Studio Stats Extractor (No FAB, Remove Logout)
// @namespace    http://tampermonkey.net/
// @version      2.8.2
// @description  Автозбір даних з Overview + Content, без рефакторингу робочих частин. Додає monetization, 4-й контейнер, Lifetime (3с), channelId.
// @match        https://studio.youtube.com/*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      script.google.com
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

  // ---------- утиліти ----------
  function getExtractButton() { return document.querySelector('#extract-button'); }
  function setButtonStatus(text) { const btn = getExtractButton(); if (btn) btn.textContent = text; }

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

  function removeSignOutMenuItem() {
    try {
      const link = document.querySelector('ytd-compact-link-renderer a[href*="/logout"], a[href^="https://www.youtube.com/logout"], a[href^="https://accounts.google.com/Logout"]');
      if (link) {
        const parentItem = link.closest('ytd-compact-link-renderer, tp-yt-paper-item');
        if (parentItem) { parentItem.remove(); dlog('Прибрано пункт "Вийти"'); }
      }
    } catch (e) { derr('removeSignOutMenuItem error:', e); }
  }

  // ---------- навігаційні кліки (імітація) ----------
  // Клік по пункту «Аналітика» (без прямого переходу)
  function clickAnalyticsTab(done) {
    dlog('Відкриваємо Аналітику (клік)…');
    // пробуємо кілька варіантів
    const tryClick = () => {
      const el =
        document.querySelector('a[title*="Аналитика"], a[title*="Analytics"], a[href*="/analytics"]') ||
        document.querySelector('#menu-paper-icon-item-2'); // запасний
      if (el) {
        el.click();
        // чекаємо, поки на екрані з’являться елементи overview
        waitForElement('.metric-value.style-scope.yta-latest-activity-card', () => {
          dlog('Аналітика відкрита');
          if (typeof done === 'function') done();
        }, 25000);
        return true;
      }
      return false;
    };
    if (!tryClick()) {
      // якщо елемент ще не в DOM — чекаємо хедер і пробуємо знову
      waitForElement('ytd-app, ytcp-header', () => { tryClick(); }, 20000);
    }
  }

  // клік по вкладці "Контент" (і ПАУЗА 3с перед парсингом)
function clickContentTab() {
  waitForElement('#content', (contentTab) => {
    contentTab.click();
    dlog('Клік по #content виконано, чекаємо 3с…');
    setTimeout(() => {
      extractContentDataAndSend();
    }, 3000); // фіксована затримка перед парсингом /tab-content
  });
}


  // ---------- основний флоу ----------
  function onExtractClick() {
    try {
      dlog('Клік по кнопці "Дані"');
      setButtonStatus('Починаю…');
      forceCollect = true;
      removeSignOutMenuItem();

      // 0) channelId з поточного URL (без переходів)
      overviewChannelId = (location.href.match(/\/channel\/([^/]+)/)?.[1]) || '';
      dlog('channelId:', overviewChannelId || '(не знайдено)');

      // 1) Відкриваємо «Аналітика» кліком, далі — Overview → Lifetime → 3с → парсинг
      clickAnalyticsTab(() => {
        extractOverviewData(() => {
          // 2) Після Overview — клікаємо Content (із 3с паузою всередині clickContentTab)
          clickContentTab(() => {
            // 3) Парсимо Content і надсилаємо
            extractContentDataAndSend();
          });
        });
      });
    } catch (e) {
      derr('onExtractClick error:', e);
      setButtonStatus('❌ Помилка');
    }
  }

  // >>> ОНОВЛЕНО згідно ТЗ: імітація кліку періоду → Lifetime → 3с очікування → парсинг → monetization + 4-й блок
  function extractOverviewData(callback) {
  try {
    dlog('Відкриваємо період і обираємо Lifetime…');
    // кнопка відкриття дропдауну періоду
    waitForElement('div[role="button"].has-label.borderless.container.style-scope.ytcp-dropdown-trigger', (periodBtn) => {
      try {
        periodBtn.click();
        // пункт меню Lifetime
        waitForElement('[test-id="lifetime"]', (lifeItem) => {
          lifeItem.click();
          dlog('Lifetime натиснуто, очікуємо 3с…');

          setTimeout(() => {
            // тепер парсимо оверв’ю
            waitForElement('.metric-value.style-scope.yta-latest-activity-card', () => {
              try {
                const metricElems = document.querySelectorAll('.metric-value.style-scope.yta-latest-activity-card');
                const subscribers = parseNumber(metricElems[0]?.textContent || '0');
                const views48h = parseNumber(metricElems[1]?.textContent || '0');

                const totals = Array.from(document.querySelectorAll('#metric-total')).map(el => (el.textContent || '').trim());
                const viewsPeriod = parseNumber(totals[0] || '0');
                const hoursPeriod = parseNumber(totals[1] || '0');

                overviewChannel = document.querySelector('#entity-name.entity-name')?.textContent.trim() || 'Без назви';
                overviewDateUTC = new Date().toISOString().split('T')[0];
                oViews48h = views48h;
                oViewsPeriod = viewsPeriod;
                oHoursPeriod = hoursPeriod;
                oSubscribers = subscribers;

               // підрахунок блоків yta-key-metric-block
                  const blocks = document.querySelectorAll('div#container.layout.vertical.style-scope.yta-key-metric-block');
                  monetization = (blocks.length === 4); // 3 → false, 4 → true
                  if (blocks[3]) {
                      const m = blocks[3].querySelector('#metric-total');
                      let val = (m?.textContent || blocks[3].innerText || '').trim();

                      // видаляємо $, ₴, €, ₽ та пробіли навколо
                      val = val.replace(/[$₴€₽]/g, '').trim();

                      if (!val || /^[-–—]+$/.test(val)) { // пусто або лише тире
                          val = '0';
                      }
                      fourthMetric = val;
                  } else {
                      fourthMetric = '';
                  }

                dlog('Overview OK:', { overviewChannel, oSubscribers, oViews48h, oViewsPeriod, oHoursPeriod, monetization, fourthMetric });
                setButtonStatus('✅ Загальна');
                if (typeof callback === 'function') callback();
              } catch (e) {
                derr('extractOverviewData parse error:', e);
                setButtonStatus('❌ Помилка');
              }
            });
          }, 3000); // обов’язкова пауза 3 секунди
        });
      } catch (e) {
        derr('extractOverviewData period click error (fallback без Lifetime):', e);
        // Фолбек: парсимо без зміни періоду
        waitForElement('.metric-value.style-scope.yta-latest-activity-card', () => {
          try {
            const metricElems = document.querySelectorAll('.metric-value.style-scope.yta-latest-activity-card');
            const subscribers = parseNumber(metricElems[0]?.textContent || '0');
            const views48h = parseNumber(metricElems[1]?.textContent || '0');

            const totals = Array.from(document.querySelectorAll('#metric-total')).map(el => (el.textContent || '').trim());
            const viewsPeriod = parseNumber(totals[0] || '0');
            const hoursPeriod = parseNumber(totals[1] || '0');

            overviewChannel = document.querySelector('#entity-name.entity-name')?.textContent.trim() || 'Без назви';
            overviewDateUTC = new Date().toISOString().split('T')[0];
            oViews48h = views48h;
            oViewsPeriod = viewsPeriod;
            oHoursPeriod = hoursPeriod;
            oSubscribers = subscribers;

            const blocks = document.querySelectorAll('div#container.layout.vertical.style-scope.yta-key-metric-block');
            monetization = (blocks.length === 4);
            if (blocks[3]) {
              const m = blocks[3].querySelector('#metric-total');
              let val = (m?.textContent || blocks[3].innerText || '').trim();
              if (!val || /^[-–—]+$/.test(val)) {
                val = '0';
              }
              fourthMetric = val;
            } else {
              fourthMetric = '';
            }

            dlog('Overview Fallback OK:', { monetization, fourthMetric });
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
// Парсер значень з різними суфіксами/форматами
function parseMetric(raw, type) {
  let text = String(raw || '')
    .replace(/\u00A0/g, ' ')  // NBSP → space
    .trim()
    .toLowerCase();

  // avgViewDuration: залишаємо формат m:ss як є
  if (type === 'avg') {
    const mmss = text.match(/^(\d{1,2}):([0-5]\d)$/);
    if (mmss) return mmss[0]; // напр. "5:08"
    return text;              // фолбек — віддаємо як є
  }

  // Витягаємо число (з комою або крапкою)
  const numMatch = text.replace(',', '.').match(/-?\d+(\.\d+)?/);
  const base = numMatch ? parseFloat(numMatch[0]) : NaN;

  if (type === 'ctr') {
    // Для CTR завжди повертаємо з символом %
    if (isNaN(base)) return '';
    // якщо в оригіналі була десяткова частина — лишаємо 1 знак
    const withDecimal = /[.,]\d/.test(text);
    const val = withDecimal ? base.toFixed(1) : String(Math.round(base));
    return `${val}%`;
  }

  if (type === 'impr') {
    if (isNaN(base)) return 0;

    // Множники: "тыс.", "тис.", "k" → ×1000; "млн", "m" → ×1e6
    let mul = 1;
    if (/(тыс|тис|k)\.?/.test(text)) mul = 1000;
    if (/(млн|m)\.?/.test(text))     mul = 1_000_000;

    return Math.round(base * mul); // 657,1 тыс. → 657100
  }

  // За замовчуванням — повертаємо число без форматування
  return isNaN(base) ? '' : base;
}

function extractContentDataAndSend() {
  try {
    // Порядок блоків на /analytics/tab-content:
    // [0] Просмотры, [1] ПоказЫ (impressions), [2] CTR, [3] Средняя продолжительность просмотра
    const totals = Array.from(document.querySelectorAll('#metric-total'))
      .map(el => (el.textContent || '').trim());

    const impressions      = parseMetric(totals[1] || '', 'impr'); // 657,1 тыс. → 657100
    const ctr              = parseMetric(totals[2] || '', 'ctr');  // 7,9 % → 7.9%
    const avgViewDuration  = parseMetric(totals[3] || '', 'avg');  // 5:08 → 5:08

    contentDateUTC = new Date().toISOString().split('T')[0];
    const contentMetrics = { impressions, ctr, avgViewDuration };

    dlog('Content metrics (normalized):', contentMetrics);
    goToVideosAndExtractCount(contentMetrics);
  } catch (e) {
    derr('extractContentDataAndSend error:', e);
    setButtonStatus('❌ Помилка');
  }
}




  function goToVideosAndExtractCount(contentMetrics) {
  dlog('Відкриваємо головне меню "Контент" (клік)…');

  // клік по пункту "Контент" у лівому меню
  const candidates = [
    '#menu-paper-icon-item-1',                         // часто саме він
    'a[title*="Контент"]',
    'a[title*="Content"]',
    'a[href*="/content"]',
    'a[href*="/videos"]',
    '#content'                                         // запасний (у деяких версіях)
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

  // 1) шукаємо елемент меню і клікаємо
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
      waitForUrlThenParse(); // все одно перейдемо до очікування URL
    }
  }, 250);

  // 2) чекаємо ПЕРЕХІД на сторінку менеджера контенту, потім 3с пауза, потім читаємо .page-description
  function waitForUrlThenParse() {
    const t0 = Date.now();
    const urlIv = setInterval(() => {
      const p = location.pathname;
      if (p.includes('/content') || p.includes('/videos')) {
        clearInterval(urlIv);
        dlog('URL = сторінка Контент, чекаємо 3с перед читанням кількості…');
        setTimeout(readTotalAndSend, 3000);
      } else if (Date.now() - t0 > 15000) {
        clearInterval(urlIv);
        dlog('Не дочекались переходу на /content|/videos за 15с (fallback). Чекаємо 3с і читаємо…');
        setTimeout(readTotalAndSend, 3000);
      }
    }, 200);
  }

  // 3) зчитуємо кількість відео і шлемо
  function readTotalAndSend() {
    try {
      // у менеджері контенту кількість зазвичай у .page-description
      waitForElement('.page-description', () => {
        const el = document.querySelector('.page-description');
        const rawText = el?.textContent || '';
        // підтримуємо декілька мовних варіантів
        const match = rawText.match(/(?:из|of|з)\s*(?:примерно|approximately)?\s*(\d+)/i);
        const total = match ? parseInt(match[1].replace(/\s/g, ''), 10) : NaN;

        if (isNaN(total)) { derr('Не вдалося визначити total з .page-description'); return; }

        const combinedData =
          `${overviewChannel};${overviewDateUTC};${oSubscribers};${oViewsPeriod};${oHoursPeriod};${oViews48h};${overviewChannel};` +
          `${contentMetrics.impressions};${contentMetrics.ctr}${'\u200B'};${contentMetrics.avgViewDuration}${'\u200B'};${contentDateUTC};${total}` +
          `;${monetization};${fourthMetric};${overviewChannelId}`;

        dlog('Відправляємо:', combinedData);
        setButtonStatus('📤 Надсилаю…');
        sendToSheet(combinedData, 'combined'); // лишаємо твою існуючу відправку/параметри
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
  dlog('Скрипт готовий');
})();
