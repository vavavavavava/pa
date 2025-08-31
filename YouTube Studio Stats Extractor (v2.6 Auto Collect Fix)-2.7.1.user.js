// ==UserScript==
// @name         YouTube Studio Stats Extractor (No FAB, Remove Logout)
// @namespace    http://tampermonkey.net/
// @version      2.8.8
// @description  Автозбір даних з Overview + Content, без рефакторингу робочих частин. Додає monetization, 4-й контейнер, Lifetime (3с), channelId.
// @match        https://studio.youtube.com/*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      script.google.com
// @run-at       document-idle
// @require https://cdn.jsdelivr.net/npm/tinyld/dist/tinyld.min.js
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

  // секундомір очікування Content (🆕)
  let contentWaitTimer = null;

  // ---------- утиліти ----------
  function getExtractButton() { return document.querySelector('#extract-button'); }
  function setButtonStatus(text) { const btn = getExtractButton(); if (btn) btn.textContent = text; }

  // 🆕 Дата за часовим поясом Лос-Анджелеса у форматі YYYY-MM-DD
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
// === АВТО-СТАТУС ДЛЯ OMNISEARCH (нове) ===
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

  // Фолбек, якщо нічого не підійшло
  return monetizationFlag ? 'Монета тінь' : 'Тінь';
}

function setOmniSearchStatus(statusText) {
  // Підміняємо Omnisearch input на статус
  try {
    waitForElement('input#query-input', (inp) => {
      if (!inp) return;
      inp.value = statusText;
      inp.setAttribute('placeholder', statusText);
      // тригеримо подію, щоб YouTube не перезаписав значення
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      dlog('OmniSearch статус:', statusText);
    }, 8000);
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
    btn.textContent = '📊 Дані'; // неактивна
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

  // Універсальний парсер з підтримкою "тыс./тис./k" і "млн/m" + очистка валютних символів
  function parseNumberWithUnits(raw) {
    let text = String(raw || '')
      .replace(/\u00A0/g, ' ')   // NBSP → пробіл
      .trim()
      .toLowerCase();

    // прибираємо валютні символи
    text = text.replace(/[$₴€₽]/g, '').trim();

    // заміна коми на крапку для десяткових
    const numMatch = text.replace(',', '.').match(/-?\d+(\.\d+)?/);
    let base = numMatch ? parseFloat(numMatch[0]) : NaN;
    if (isNaN(base)) return 0;

    // множники
    if (/(тыс|тис|k)\.?/.test(text)) base *= 1000;
    if (/(млн|m)\.?/.test(text))     base *= 1_000_000;

    return base;
  }
// === YSE: стилі бейджа в Omnisearch (нове) ===
// === YSE: стилі бейджа, що імітує поле пошуку ===
(function injectYseBadgeStyles() {
  if (document.getElementById('yse-badge-styles')) return;
  const css = `
    .yse-badge-search {
      display: flex;
      align-items: center;
      width: 100%;
      box-sizing: border-box;
      padding: 0 12px;
      height: 40px;                 /* fallback — далі спробуємо підмінити з обчислених стилів */
      border-radius: 24px;          /* fallback */
      background: rgba(255,255,255,0.06); /* fallback для dark */
      border: 1px solid rgba(255,255,255,0.12); /* fallback */
      gap: 10px;
      cursor: default;
      user-select: none;
      font-weight: 500;
      font-size: 14px;
      line-height: 1;
    
      justify-content: center;
      gap: 0;
    }
    .yse-search-icon {
      width: 20px; height: 20px; flex: 0 0 20px;
      opacity: .72;
    }
    .yse-chip {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 4px 8px; border-radius: 999px; font-weight: 600;
      border: 1px solid transparent; line-height: 1;
    
      width: 100%;
      text-align: center;
      justify-content: center;
      padding: 6px 0;
    }
    /* кольори чипа */
    .yse-chip-green  { color: #22c55e; background: rgba(34,197,94,0.12);  border-color: rgba(34,197,94,0.25); }
    .yse-chip-orange { color: #f59e0b; background: rgba(245,158,11,0.12); border-color: rgba(245,158,11,0.25); }
    .yse-chip-blue   { color: #3b82f6; background: rgba(59,130,246,0.12); border-color: rgba(59,130,246,0.25); }
    .yse-chip-red    { color: #ef4444; background: rgba(239,68,68,0.12);  border-color: rgba(239,68,68,0.25); }
    .yse-chip-gray   { color: #9ca3af; background: rgba(156,163,175,0.12);border-color: rgba(156,163,175,0.25); }

    .yse-status-text { opacity: .92; }
    .yse-badge-search.yse-no-bg { background: transparent !important; border: none !important; }
  `;
  const style = document.createElement('style');
  style.id = 'yse-badge-styles';
  style.textContent = css;
  document.head.appendChild(style);
})();


// Маппер кольорів за назвою статусу
function yseGetStatusColorClass(statusText = '') {
  const s = String(statusText).toLowerCase();
  if (s.includes('топ')) return 'yse-green';
  if (s.includes('гуд')) return 'yse-orange';
  if (s.includes('норм')) return 'yse-blue';
  if (s.includes('заміна') || s.includes('тінь')) return 'yse-red';
  if (s.includes('нуляч')) return 'yse-gray';
  // дефолт — синій
  return 'yse-blue';
}
// === Helpers added to fix ReferenceError & style copy ===
// Map color class name to chip class name, e.g. "yse-green" -> "yse-chip-green"
const yseGetStatusChipClass = (statusText = '') => {
  try {
    const base = yseGetStatusColorClass(statusText); // returns yse-green / yse-orange / ...
    return base.replace(/^yse-/, 'yse-chip-');       // -> yse-chip-green / ...
  } catch (e) {
    return 'yse-chip-blue';
  }
};

// Copy size/rounded/padding from the search layer so our badge matches the search field look
function yseApplyBoxLookFromLayer(layer, box) {
  try {
    if (!layer || !box) return;
    const cs = getComputedStyle(layer);
    if (cs) {
      if (cs.height) box.style.height = cs.height;
      if (cs.borderRadius) box.style.borderRadius = cs.borderRadius;
      if (cs.padding) box.style.padding = cs.padding;
      if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') {
        box.style.background = cs.backgroundColor;
      }
      if (cs.border && cs.border !== '0px none rgb(0, 0, 0)') {
        box.style.border = cs.border;
      }
    }
    // Also try to mirror the inner input styles if present
    const inp = layer.querySelector('input, #query-input');
    if (inp) {
      const ci = getComputedStyle(inp);
      if (ci.height) box.style.height = ci.height;
      if (ci.borderRadius) box.style.borderRadius = ci.borderRadius;
      if (ci.padding) box.style.padding = ci.padding;
      if (ci.fontSize) box.style.fontSize = ci.fontSize;
      if (ci.lineHeight) box.style.lineHeight = ci.lineHeight;
    }
  } catch (_) { /* no-op */ }
}


// Створення/оновлення кастомного бейджа замість інпута пошуку
// Замінює контент у #search-layer на наш бейдж-статус (без видалення вузла)
function setOmniSearchBadge(statusText) {
  try {
    waitForElement('div#search-layer.style-scope.ytcp-omnisearch', (layer) => {
      if (!layer) return;

      // 1) сховати всі штатні елементи пошуку
      Array.from(layer.childNodes || []).forEach((n) => { if (n && n.style) n.style.display = 'none'; });

      // 2) створити/оновити наш бокс
      let box = layer.querySelector('#yse-status-box');
      const chipClass = yseGetStatusChipClass(statusText);

      if (!box) {
        box = document.createElement('div');
        box.id = 'yse-status-box';
        box.className = 'yse-badge-search';

        const chip = document.createElement('span');
        chip.className = `yse-chip ${chipClass}`;
        chip.textContent = statusText;

        box.appendChild(chip);

        // застосуємо стилі шару, щоб виглядати як поле пошуку
        yseApplyBoxLookFromLayer(layer, box);

        layer.appendChild(box);

        // спостерігач, щоб відновлювати блок при перерисовці
        const mo = new MutationObserver(() => {
          if (!layer.contains(box)) {
            const re = document.createElement('div');
            re.id = 'yse-status-box';
            re.className = 'yse-badge-search';
            const c2 = document.createElement('span');
            c2.className = `yse-chip ${chipClass}`;
            c2.textContent = statusText;
            re.appendChild(c2);
            yseApplyBoxLookFromLayer(layer, re);
            layer.appendChild(re);
            box = re;
          }
          // знов сховаємо стандартні елементи
          Array.from(layer.childNodes || []).forEach((n) => {
            if (n && n !== box && n.style) n.style.display = 'none';
          });
        });
        mo.observe(layer, { childList: true, subtree: false });
      } else {
        // оновлення існуючого чипа
        const chip = box.querySelector('.yse-chip');
        if (chip) {
          chip.className = `yse-chip ${chipClass}`;
          chip.textContent = statusText;
        }
      }

      if (statusText && box) { box.classList.add('yse-no-bg'); }
      dlog('OmniSearch: замінено на чип статусу без іконки:', statusText);
    }, 10000);
  } catch (e) {
    derr('setOmniSearchBadge error:', e);
  }
}


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
      dlog('Клік по #content виконано, чекаємо приховання #right-side-bar…');

      // 🆕 старт динамічного секундоміра "⏱️ Контент Nс"
      try {
        if (contentWaitTimer) { clearInterval(contentWaitTimer); contentWaitTimer = null; }
        let secs = 0;
        setButtonStatus(`⏱️ Контент ${secs}с`);
        contentWaitTimer = setInterval(() => {
          secs += 1;
          setButtonStatus(`⏱️ Контент ${secs}с`);
        }, 1000);
      } catch (e) {
        // не критично
      }

      // очікування поки #right-side-bar стане display:none
      const start = Date.now();
      const iv = setInterval(() => {
        const el = document.querySelector('#right-side-bar');
        if (el && el.style.display === 'none') {
          clearInterval(iv);
          // 🆕 стоп секундоміра
          if (contentWaitTimer) { clearInterval(contentWaitTimer); contentWaitTimer = null; }
          dlog('#right-side-bar приховано, парсимо Content');
          extractContentDataAndSend();
        } else if (Date.now() - start > 20000) { // таймаут 20с
          clearInterval(iv);
          // 🆕 стоп секундоміра (fallback)
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
      setButtonStatus('🔄 Починаю…');   // старт
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
                  const subscribers = parseNumber(metricElems[0]?.textContent || '0');  // залишаємо базовий парсер
                  const views48h = parseNumber(metricElems[1]?.textContent || '0');     // залишаємо базовий парсер

                  // totals: [0] = views (за період), [1] = watch hours (за період)
                  const totals = Array.from(document.querySelectorAll('#metric-total')).map(el => (el.textContent || '').trim());
                  const viewsPeriod = parseNumberWithUnits(totals[0] || '0');  // підтримка тыс/млн
                  const hoursPeriod = parseNumberWithUnits(totals[1] || '0');  // підтримка тыс/млн

                  overviewChannel = document.querySelector('#entity-name.entity-name')?.textContent.trim() || 'Без назви';
                  overviewDateUTC = getDateInLA(); // 🆕 LA date
                  oViews48h = views48h;
                  oViewsPeriod = viewsPeriod;
                  oHoursPeriod = hoursPeriod;
                  oSubscribers = subscribers;

                  // підрахунок блоків yta-key-metric-block + 4-й блок (дохід)
                  const blocks = document.querySelectorAll('div#container.layout.vertical.style-scope.yta-key-metric-block');
                  monetization = (blocks.length === 4); // 3 → false, 4 → true
                  if (blocks[3]) {
                    const m = blocks[3].querySelector('#metric-total');
                    let val = (m?.textContent || blocks[3].innerText || '').trim();
                    // одразу нормалізуємо (прибирає $, конвертує тыс/млн)
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
            }, 3000); // обов’язкова пауза 3 секунди
          });
        } catch (e) {
          derr('extractOverviewData period click error (fallback без Lifetime):', e);
          // Фолбек: парсимо без зміни періоду (але з тією ж нормалізацією значень)
          waitForElement('.metric-value.style-scope.yta-latest-activity-card', () => {
            try {
              const metricElems = document.querySelectorAll('.metric-value.style-scope.yta-latest-activity-card');
              const subscribers = parseNumber(metricElems[0]?.textContent || '0');
              const views48h = parseNumber(metricElems[1]?.textContent || '0');

              const totals = Array.from(document.querySelectorAll('#metric-total')).map(el => (el.textContent || '').trim());
              const viewsPeriod = parseNumberWithUnits(totals[0] || '0');
              const hoursPeriod = parseNumberWithUnits(totals[1] || '0');

              overviewChannel = document.querySelector('#entity-name.entity-name')?.textContent.trim() || 'Без назви';
              overviewDateUTC = getDateInLA(); // 🆕 LA date (fallback)
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
      // 🆕 безпечне вимкнення секундоміра, якщо ще працює
      if (contentWaitTimer) { clearInterval(contentWaitTimer); contentWaitTimer = null; }

      // Порядок на /analytics/tab-content:
      // [0] Views, [1] Impressions, [2] CTR, [3] Average view duration
      const totals = Array.from(document.querySelectorAll('#metric-total'))
        .map(el => (el.textContent || '').trim());

      // Impressions з підтримкою тыс./млн (k/m)
      const impressions = parseNumberWithUnits(totals[1] || '0');

      // CTR завжди з відсотком (7.9%)
      const ctrText = (totals[2] || '').replace(/\u00A0/g, ' ').trim().toLowerCase();
      const ctrNumMatch = ctrText.replace(',', '.').match(/-?\d+(\.\d+)?/);
      const ctr = ctrNumMatch ? `${(+ctrNumMatch[0]).toFixed(/[.,]\d/.test(ctrText) ? 1 : 0)}%` : '';

      // Average view duration у форматі m:ss — залишаємо як є
      const avgRaw = (totals[3] || '').trim();
      const avgViewDuration = /^\d{1,2}:[0-5]\d$/.test(avgRaw) ? avgRaw : avgRaw;

      contentDateUTC = getDateInLA(); // 🆕 LA date
      const contentMetrics = { impressions, ctr, avgViewDuration };

      dlog('Content metrics (normalized):', contentMetrics);
      setButtonStatus('✅ Контент'); // контент зпаршено
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

  // 2) чекаємо ПЕРЕХІД на сторінку менеджера контенту, одразу читаємо .page-description (БЕЗ 3с таймауту)
  function waitForUrlThenParse() {
    const t0 = Date.now();
    const urlIv = setInterval(() => {
      const p = location.pathname;
      if (p.includes('/content') || p.includes('/videos')) {
        clearInterval(urlIv);
        dlog('URL = сторінка Контент, одразу читаємо кількість (без 3с)…');
        readTotalAndSend(); // ← без затримки
      } else if (Date.now() - t0 > 15000) {
        clearInterval(urlIv);
        dlog('Не дочекались переходу на /content|/videos за 15с (fallback). Читаємо одразу…');
        readTotalAndSend(); // ← без затримки
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
// 🆕 Авто-статус у пошуку за правилами
const autoStatus = computeAutoStatus({
  monetizationFlag: monetization,
  views48h: oViews48h,
  hoursLifetime: oHoursPeriod,   // Lifetime годинник уже нормалізований
  subscribers: oSubscribers,
  totalVideos: total
});
setOmniSearchBadge(autoStatus);

        dlog('Відправляємо:', combinedData);
        setButtonStatus('✉️ Відправка'); // статус перед надсиланням
        sendToSheet(combinedData, 'combined'); // лишаємо існуючу відправку/параметри
        setButtonStatus('✅ Готово');         // після завершення запиту (відповідь не очікуємо)
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

  // тримаємо кнопку "Дані" живою (ре-інʼєкція, якщо YT перерисував хедер)
  const keepBtnAliveIv = setInterval(() => {
    if (!getExtractButton()) ensureHeaderButton();
  }, 1000);

  // автоприбирання пункту "Вийти" (спостерігач за всім body)
  const signOutObserver = new MutationObserver(() => removeSignOutMenuItem());
  signOutObserver.observe(document.body, { childList: true, subtree: true });

  // первинний виклик, щоб прибрати одразу
  removeSignOutMenuItem();

  dlog('Script ready');
   /* === LangBadge add-on (tinyld + smart fallback, ::after inline, 2025-08) ===
     Що робить:
       • Додає прапор + назву мови справа від тайтлу як псевдоконтент ::after
       • Працює в двох місцях:
           1) ytd-account-item-renderer #channel-title (дроплист акаунтів)
           2) #entity-name (лівий дровер)
       • Не ламає верстку: без чіпів, без додаткових елементів, ширина тайтлу
         штучно розширюється під "Назва + Мова".
     Детектор:
       • Спершу tinyld (UMD) з @require
       • Якщо tinyld недоступний/повернув 'la'/'und' — локальна евристика (DE/IT/EN + кирилиця)
  ============================================================================ */

  // ====== мапи назв і прапорів (ISO 639-1) ==================================
  const ISO2_TO_LABEL = {
    uk:'Ukrainian', ru:'Russian', be:'Belarusian', bg:'Bulgarian',
    pl:'Polish', cs:'Czech', sk:'Slovak', sl:'Slovenian',
    hr:'Croatian', sr:'Serbian', mk:'Macedonian',
    en:'English', de:'German', nl:'Dutch', fr:'French', es:'Spanish',
    pt:'Portuguese', it:'Italian', ro:'Romanian', hu:'Hungarian',
    tr:'Turkish', ar:'Arabic', he:'Hebrew', el:'Greek',
    ja:'Japanese', ko:'Korean', zh:'Chinese',
    vi:'Vietnamese', id:'Indonesian', ms:'Malay', th:'Thai'
  };
  const iso2Label = (code) => ISO2_TO_LABEL[code] || (code ? code.toUpperCase() : 'Unknown');

  const LANG_FLAG = {
    de:'🇩🇪', it:'🇮🇹', en:'🇬🇧', uk:'🇺🇦', ru:'🇷🇺', pl:'🇵🇱', cs:'🇨🇿', sk:'🇸🇰',
    sl:'🇸🇮', hr:'🇭🇷', sr:'🇷🇸', mk:'🇲🇰', nl:'🇳🇱', fr:'🇫🇷', es:'🇪🇸', pt:'🇵🇹',
    ro:'🇷🇴', hu:'🇭🇺', tr:'🇹🇷', ar:'🇸🇦', he:'🇮🇱', el:'🇬🇷', ja:'🇯🇵', ko:'🇰🇷',
    zh:'🇨🇳', vi:'🇻🇳', id:'🇮🇩', ms:'🇲🇾', th:'🇹🇭'
  };
  const flagFor = (code) => LANG_FLAG[code] || '🌐';

  // ====== tinyld детектор (UMD як функція або об'єкт із .detect) =============
  function getDetector() {
    const t = window.tinyld;
    if (!t) return null;
    if (typeof t === 'function') return { detect: (txt) => t(txt) };
    if (typeof t.detect === 'function') return t;
    return null;
  }

  // ====== евристики (DE/IT/EN + кирилиця, діакритика, стоп-слова) ============
  const DE_MARKERS = [' der ',' die ',' das ',' und ',' mit ',' für ',' nicht ',' berühren ',' glück ',' zum ',' vom ',' einem ',' einer ',' über '];
  const IT_MARKERS = [' di ',' e ',' la ',' le ',' gli ',' delle ',' degli ',' nelle ',' emozioni ',' nascosto ',' nascoste ',' sotto ',' tra '];
  const EN_MARKERS = [' and ',' with ',' for ',' the ',' hidden ',' moment ',' touch '];
  const DE_DIACRITICS = /[äöüß]/i;
  const IT_DIACRITICS = /[àèéìíîòóù]/i;
  const HAS_CYRILLIC = /[А-Яа-яЁёІіЇїЄєҐґ]/;

  function scoreByMarkers(text, markers) { let s=0; for (const m of markers) if (text.includes(m)) s++; return s; }
  function heuristicLangCode(textRaw) {
    const t = ' ' + String(textRaw || '').toLowerCase().normalize('NFC') + ' ';
    if (HAS_CYRILLIC.test(t)) return 'uk';
    if (DE_DIACRITICS.test(t)) return 'de';
    if (IT_DIACRITICS.test(t)) return 'it';
    if (/\b(die|der|zum|vom|über)\b/.test(t)) return 'de';
    if (/\b(di|gli|delle|degli|nascoste|emozioni)\b/.test(t)) return 'it';
    const de = scoreByMarkers(t, DE_MARKERS);
    const it = scoreByMarkers(t, IT_MARKERS);
    const en = scoreByMarkers(t, EN_MARKERS);
    if (de > it && de >= 1) return 'de';
    if (it > de && it >= 1) return 'it';
    if (en >= 2 && en >= de && en >= it) return 'en';
    return null;
  }

  // ====== основне визначення мови (код + назва + прапор) =====================
  function detectLang(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return { label:'Unknown', code:null, flag:'🌐' };

    if (clean.length <= 3) {
      if (HAS_CYRILLIC.test(clean)) return { label:'Ukrainian', code:'uk', flag:flagFor('uk') };
      return { label:'Unknown', code:null, flag:'🌐' };
    }

    // 1) tinyld
    try {
      const det = getDetector();
      if (det) {
        const out = det.detect(clean);
        let code = null;
        if (typeof out === 'string') code = out;
        else if (Array.isArray(out) && out[0]) code = out[0].lang || out[0].code || out[0].language;
        else if (out && typeof out === 'object') code = out.lang || out.code || out.language;
        if (code && code !== 'la' && code !== 'und' && code !== 'xx') {
          return { label: iso2Label(code), code, flag: flagFor(code) };
        }
      }
    } catch {}

    // 2) локальна евристика
    const h = heuristicLangCode(clean);
    if (h) return { label: iso2Label(h), code: h, flag: flagFor(h) };

    return { label:'Unknown', code:null, flag:'🌐' };
  }

  // ====== стилі: ::after + розширення блоку назви під "Назва + Мова" =========
  (function injectLangInlineAfterStyles(){
    if (document.getElementById('yse-lang-inline-after')) return;
    const style = document.createElement('style');
    style.id = 'yse-lang-inline-after';
    style.textContent = `
      /* робимо сам тайтл гнучким під «Назва + Мова» */
      ytd-account-item-renderer #channel-title,
      #entity-name.entity-name {
        display: inline-block !important;
        width: auto !important;
        max-width: none !important;
        white-space: nowrap !important;
        vertical-align: baseline !important;
      }
      /* показуємо праворуч прапор + назву мови як псевдоконтент */
      ytd-account-item-renderer #channel-title[data-lang-label]::after,
      #entity-name.entity-name[data-lang-label]::after {
        content: " " attr(data-lang-label);
        font: 500 11px/1.2 Roboto, Arial, sans-serif;
        white-space: nowrap;
        opacity: .85;
        margin-left: 6px;
      }
    `;
    document.head.appendChild(style);
  })();

  // ====== записуємо лейбл у data-атрибут (ніяких нових DOM-вузлів) ===========
  function setInlineAfterLabel(targetEl, langObj){
    if (!targetEl || !langObj) return;
    targetEl.setAttribute('data-lang-label', `${langObj.flag} ${langObj.label}`);
  }

  // ====== readiness helpers ==================================================
  function waitFor(condFn, onOk, timeoutMs = 12000, intervalMs = 120) {
    const t0 = Date.now();
    const iv = setInterval(() => {
      try { if (condFn()) { clearInterval(iv); onOk(); }
            else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); } }
      catch { clearInterval(iv); }
    }, intervalMs);
  }
  function waitForStableText(el, onStable, minLen = 2, quietMs = 200, timeoutMs = 8000) {
    let last = (el.textContent || '').trim();
    if (last.length >= minLen) {
      let timer = setTimeout(() => onStable(el), quietMs);
      const mo = new MutationObserver(() => {
        const cur = (el.textContent || '').trim();
        if (cur === last) return;
        last = cur; clearTimeout(timer);
        timer = setTimeout(() => { mo.disconnect(); onStable(el); }, quietMs);
      });
      mo.observe(el, { characterData:true, childList:true, subtree:true });
      setTimeout(() => { try { mo.disconnect(); } catch {} }, timeoutMs);
      return;
    }
    const mo = new MutationObserver(() => {
      const cur = (el.textContent || '').trim();
      if (cur.length >= minLen) { mo.disconnect(); waitForStableText(el, onStable, minLen, quietMs, timeoutMs); }
    });
    mo.observe(el, { characterData:true, childList:true, subtree:true });
    setTimeout(() => { try { mo.disconnect(); } catch {} }, timeoutMs);
  }

  function readyThenDetectAndRender(selector) {
    const runner = (el) => {
      waitForStableText(el, () => {
        const t = (el.textContent || '').trim();
        const langObj = detectLang(t);
        setInlineAfterLabel(el, langObj);
      });
    };
    if (typeof waitForElement === 'function') {
      waitForElement(selector, runner, 12000);
    } else {
      waitFor(() => !!document.querySelector(selector), () => runner(document.querySelector(selector)), 12000);
    }
  }

  // ====== разові рендери для поточного DOM ==================================
  function renderAccountListInlineAfter(){
    document.querySelectorAll('ytd-account-item-renderer #channel-title').forEach((el)=>{
      const langObj = detectLang((el.textContent||'').trim());
      setInlineAfterLabel(el, langObj);
    });
  }
  function renderDrawerInlineAfter(){
    const el = document.querySelector('#entity-name.entity-name');
    if(!el) return;
    const langObj = detectLang((el.textContent||'').trim());
    setInlineAfterLabel(el, langObj);
  }

  // ====== ініціалізація ======================================================
  try {
    readyThenDetectAndRender('ytd-account-item-renderer #channel-title');
    readyThenDetectAndRender('#entity-name.entity-name');
  } catch {}

  // ====== debounce мутацій (Studio динамічне) ================================
  let langMoScheduled = false;
  const safeKick = () => {
    if (langMoScheduled) return;
    langMoScheduled = true;
    setTimeout(() => {
      langMoScheduled = false;
      renderAccountListInlineAfter();
      renderDrawerInlineAfter();
    }, 250);
  };

  const moTargets = [document.body, document.querySelector('ytd-app') || document.documentElement].filter(Boolean);
  const langMo = new MutationObserver(safeKick);
  moTargets.forEach(t => langMo.observe(t, { childList:true, subtree:true }));

  setInterval(safeKick, 3500);

})();
