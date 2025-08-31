// ==UserScript==
// @name         YouTube Studio Stats Extractor (No FAB, Remove Logout)
// @namespace    http://tampermonkey.net/
// @version      2.8.9
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
/* === LangBadge add-on (tinyld + tuned heuristics + ::after/float, 2025-08) =====
   Показує праворуч від назви: <FLAG> <Language>.
   1) ::after без дод. вузлів; 2) якщо ::after не видно — абсолютний float збоку.
   @require https://cdn.jsdelivr.net/npm/tinyld/dist/tinyld.min.js
=============================================================================== */

const ISO2_TO_LABEL = {
  ja:'Japanese', pl:'Polish', de:'German', ar:'Arabic', nl:'Dutch',
  es:'Spanish', ru:'Russian', tr:'Turkish', pt:'Portuguese', it:'Italian',
  zh:'Chinese', ko:'Korean', ro:'Romanian', el:'Greek', uk:'Ukrainian',
  id:'Indonesian', hu:'Hungarian', en:'English', hi:'Hindi', fi:'Finnish',
  he:'Hebrew', no:'Norwegian', ms:'Malay', sv:'Swedish', fr:'French',
  cs:'Czech', tl:'Filipino', sr:'Serbian', th:'Thai', da:'Danish', vi:'Vietnamese'
};
const LANG_FLAG = {
  ja:'🇯🇵', pl:'🇵🇱', de:'🇩🇪', ar:'🇸🇦', nl:'🇳🇱',
  es:'🇪🇸', ru:'🇷🇺', tr:'🇹🇷', pt:'🇵🇹', it:'🇮🇹',
  zh:'🇨🇳', ko:'🇰🇷', ro:'🇷🇴', el:'🇬🇷', uk:'🇺🇦',
  id:'🇮🇩', hu:'🇭🇺', en:'🇺🇸', hi:'🇮🇳', fi:'🇫🇮',
  he:'🇮🇱', no:'🇳🇴', ms:'🇲🇾', sv:'🇸🇪', fr:'🇫🇷',
  cs:'🇨🇿', tl:'🇵🇭', sr:'🇷🇸', th:'🇹🇭', da:'🇩🇰', vi:'🇻🇳'
};
const iso2Label = c => ISO2_TO_LABEL[c] || (c ? c.toUpperCase() : 'Unknown');
const flagFor   = c => LANG_FLAG[c]     || '🌐';

// safe normalize
function safeNormalize(str, form='NFC'){ try{return String(str).normalize(form);}catch{return String(str);} }
function normalizeText(raw){
  return safeNormalize(raw,'NFC')
    .replace(/[\u2019\u2018\u2032\u00B4\u0060]/g,"'") // ’ ‘ ′ ´ `
    .toLowerCase();
}

// tinyld UMD
function getDetector(){
  const t = window.tinyld;
  if(!t) return null;
  if(typeof t === 'function') return { detect:(txt)=>t(txt) };
  if(typeof t.detect === 'function') return t;
  return null;
}

/* ================= Heuristics (return ISO2 or null) ================== */
// scripts
const RE_AR   = /[\u0600-\u06FF]/;
const RE_HE   = /[\u0590-\u05FF]/;
const RE_EL   = /[\u0370-\u03FF]/;
const RE_CYR  = /[\u0400-\u04FF]/;
const RE_UA   = /[ІіЇїЄєҐґ]/;
const RE_DEV  = /[\u0900-\u097F]/;
const RE_THAI = /[\u0E00-\u0E7F]/;
const RE_HANG = /[\uAC00-\uD7AF]/;
const RE_HIRA = /[\u3040-\u309F]/;
const RE_KATA = /[\u30A0-\u30FF]/;
const RE_HAN  = /[\u3400-\u9FFF\uF900-\uFAFF]/;

// latin diacritics
const RE_DE   = /[äöüß]/i;
const RE_IT   = /[àèéìíîòóù]/i;
const RE_FR   = /[àâçéèêëîïôûùüÿ]/i;
const RE_RO   = /[ăâîșşţț]/i;
const RE_PL   = /[ąćęłńóśźż]/i;
const RE_CZ   = /[ěščřžýáíéůú]/i;
const RE_HU   = /[áéíóöőúüű]/i;
const RE_SV   = /[åäö]/i;
const RE_NO_DA= /[æøå]/i;
const RE_PT   = /[ãõáâàéêíóôúç]/i;
const RE_ES   = /[áéíóúñü]/i;
const RE_VI   = /[ăâêôơưđĂÂÊÔƠƯĐ]/;

// ⚠️ Turkish: strict set — БЕЗ ö/ü (щоб не чіпати німецьку)
const RE_TR_STRICT = /[ğşıİç]/i;

// keywords
const KW_DE = /\b(die|der|das|des|und|zum|vom|über|mit|für|ohne|leben|stille|wahrheiten|momente|erinnerungen|schicksal|bruchst[üu]cke)\b/i;
const KW_IT = /\b(di|gli|le|la|lo|il|un|una|uno|nelle|delle|degli|sotto|tra|fra|con|per|che|oltre)\b|emozion/i;
const SUF_IT= /(zione|zioni|mente)\b/i;

const KW_ES = /\b(de|del|la|el|que|sin|entre|lo)\b|verdad|momentos|cuentan|cuenta/i;
const KW_PT = /\b(de|do|da|dos|das|que)\b|verdade|coração|histórias|instantes|vozes|vida\b/i;

const KW_TR = /\b(hayat(?:ın)?|yaşam(?:ın)?|gerçek|hikaye(?:si|ler[ie]?)|gece|itiraf(?:ları)?|söylenmeyen|geç|kalm[ıi]ş|kırık|parçalar[ıi]|gönülden|sözler|hikayeler)\b/i;

const KW_NL = /\b(de|het|van|en)\b|verhalen|waarheid|levens|kleine|grote|ongezegde/i;
const KW_EN = /\b(the|and|with|for|of|that)\b|stories|moments|truth/i;
const KW_RO = /inim[ăa]|via[ţț]a|f[aă]r[aă]|emo[țt]ii|n[eé]spuse|voc[iile]|glasul|voci(?:le)?/i;
const KW_ID = /\b(kisah|cerita|kehidupan|benar|rahasia|yang|tak|terucap|suara|hati|jiwa|hidup)\b/i;
const KW_MS = /\b(cerita|hidup|suara|kehidupan|benar)\b/i;
const KW_TL = /\b(totoong|kwento|buhay|mga|tadhana|alaala|piraso)\b/i;
const KW_SV = /\b(från|hjärtat|sanna)\b/i;
const KW_NO = /\b(kjærlighet|livet|øyeblikk|ord|fra)\b/i;
const KW_DA = /\b(uden|livet|ord|fra)\b/i;
const KW_SR_LAT = /[čćđšž]|\bpri[čc]e\b|\biz\b/i;

function heuristicLangCode(textRaw){
  const t = (' ' + normalizeText(textRaw) + ' ').replace(/\s+/g,' ');

  // scripts
  if (RE_AR.test(t))   return 'ar';
  if (RE_HE.test(t))   return 'he';
  if (RE_EL.test(t))   return 'el';
  if (RE_DEV.test(t))  return 'hi';
  if (RE_THAI.test(t)) return 'th';
  if (RE_HANG.test(t)) return 'ko';
  if (RE_HIRA.test(t) || RE_KATA.test(t)) return 'ja';
  if (RE_HAN.test(t))  return 'zh';
  if (RE_CYR.test(t))  return RE_UA.test(t) ? 'uk' : 'ru';
  if (RE_VI.test(t))   return 'vi';

  // German (спочатку DE, щоб не перехопив TR)
  if (RE_DE.test(t) || KW_DE.test(t)) return 'de';

  // Italian
  if (RE_IT.test(t) || KW_IT.test(t) || SUF_IT.test(t)) return 'it';

  // Portuguese / Spanish
  if (RE_PT.test(t) || KW_PT.test(t)) return 'pt';
  if (RE_ES.test(t) || KW_ES.test(t)) return 'es';

  // Turkish — тільки strict букви або явні ключі
  if (RE_TR_STRICT.test(t) || KW_TR.test(t)) return 'tr';

  // інші латиниці
  if (RE_FR.test(t)) return 'fr';
  if (RE_RO.test(t) || KW_RO.test(t)) return 'ro';
  if (RE_PL.test(t)) return 'pl';
  if (RE_CZ.test(t)) return 'cs';
  if (RE_HU.test(t)) return 'hu';

  if (RE_SV.test(t) || KW_SV.test(t)) return 'sv';
  if (RE_NO_DA.test(t)) {
    if (KW_NO.test(t)) return 'no';
    if (KW_DA.test(t)) return 'da';
    if (/kj[æa]rl/.test(t)) return 'no';
    if (/uden/.test(t)) return 'da';
    return 'no';
  }

  if (KW_NL.test(t))  return 'nl';
  if (KW_TL.test(t))  return 'tl';
  if (KW_ID.test(t))  return 'id';
  if (KW_MS.test(t))  return 'ms';
  if (KW_SR_LAT.test(t)) return 'sr';
  if (KW_EN.test(t))  return 'en';

  return null;
}

/* ========================== Final detect =========================== */
function detectLang(text){
  const clean = safeNormalize(text,'NFC').replace(/\s+/g,' ').trim();
  if(!clean) return { label:'Unknown', code:null, flag:'🌐' };
  if (clean.length <= 3) {
    if (RE_CYR.test(clean)) return { label:'Ukrainian', code:'uk', flag:flagFor('uk') };
    return { label:'Unknown', code:null, flag:'🌐' };
  }

  try{
    const det = getDetector();
    if(det){
      const out = det.detect(clean);
      let code = null;
      if (typeof out === 'string') code = out.toLowerCase();
      else if (Array.isArray(out) && out[0]) code = (out[0].lang||out[0].code||out[0].language||'').toLowerCase();
      else if (out && typeof out === 'object') code = (out.lang||out.code||out.language||'').toLowerCase();
      if (code && ISO2_TO_LABEL[code]) {
        return { label: iso2Label(code), code, flag: flagFor(code) };
      }
    }
  }catch{}

  const h = heuristicLangCode(clean);
  if (h && ISO2_TO_LABEL[h]) return { label: iso2Label(h), code: h, flag: flagFor(h) };
  return { label:'Unknown', code:null, flag:'🌐' };
}

/* ============================ CSS & render ========================== */
(function injectLangStyles(){
  if(document.getElementById('yse-lang-inline-after')) return;
  const style=document.createElement('style');
  style.id='yse-lang-inline-after';
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
    yt-formatted-string#channel-title[data-lang-label]::after,
    ytd-account-item-renderer #channel-title[data-lang-label]::after,
    #entity-name.entity-name[data-lang-label]::after {
      content: " " attr(data-lang-label);
      font:500 11px/1.2 Roboto,Arial,sans-serif;
      white-space:nowrap;
      opacity:.85;
      margin-left:6px;
    }
    .yse-lang-float {
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

function setInlineAfterLabel(el, langObj){
  if(!el || !langObj) return;
  const text = `${langObj.flag} ${langObj.label}`;
  el.setAttribute('data-lang-label', text);

  // ::after visible?
  let afterContent = '';
  try { afterContent = window.getComputedStyle(el, '::after').getPropertyValue('content'); } catch {}
  const visible = afterContent && afterContent !== 'none' && afterContent.replace(/["']/g,'').trim().length>0;

  if(!visible){
    let float = el.parentNode && el.parentNode.querySelector(':scope > .yse-lang-float');
    if(!float){
      float = document.createElement('span');
      float.className = 'yse-lang-float';
      el.parentNode && el.parentNode.insertBefore(float, el.nextSibling);
    }
    float.textContent = text;
  }else{
    const sib = el.parentNode && el.parentNode.querySelector(':scope > .yse-lang-float');
    if(sib) try{ sib.remove(); }catch{}
  }
}

/* ============================= Helpers ============================= */
function waitFor(condFn,onOk,timeoutMs=12000,intervalMs=120){
  const t0=Date.now(); const iv=setInterval(()=>{
    try{ if(condFn()){clearInterval(iv);onOk();}
         else if(Date.now()-t0>timeoutMs){clearInterval(iv);} }
    catch{ clearInterval(iv); }
  },intervalMs);
}
function waitForStableText(el,onStable,minLen=2,quietMs=200,timeoutMs=8000){
  let last=(el.textContent||'').trim();
  if(last.length>=minLen){
    let timer=setTimeout(()=>onStable(el),quietMs);
    const mo=new MutationObserver(()=>{
      const cur=(el.textContent||'').trim();
      if(cur===last) return;
      last=cur; clearTimeout(timer);
      timer=setTimeout(()=>{ try{mo.disconnect();}catch{} onStable(el); },quietMs);
    });
    mo.observe(el,{characterData:true,childList:true,subtree:true});
    setTimeout(()=>{ try{mo.disconnect();}catch{} },timeoutMs);
    return;
  }
  const mo=new MutationObserver(()=>{
    const cur=(el.textContent||'').trim();
    if(cur.length>=minLen){ mo.disconnect(); waitForStableText(el,onStable,minLen,quietMs,timeoutMs); }
  });
  mo.observe(el,{characterData:true,childList:true,subtree:true});
  setTimeout(()=>{ try{mo.disconnect();}catch{} },timeoutMs);
}
function readyThenDetectAndRender(selector){
  const run=(el)=>{
    waitForStableText(el, ()=>{
      const t=(el.textContent||'').trim();
      const langObj=detectLang(t);
      setInlineAfterLabel(el, langObj);
    });
  };
  if(typeof waitForElement==='function'){
    waitForElement(selector, run, 12000);
  }else{
    waitFor(()=>!!document.querySelector(selector), ()=>run(document.querySelector(selector)), 12000);
  }
}

/* =========================== Init & observers ====================== */
function renderAccountList(){
  document.querySelectorAll('ytd-account-item-renderer #channel-title, yt-formatted-string#channel-title').forEach((el)=>{
    const langObj = detectLang((el.textContent||'').trim());
    setInlineAfterLabel(el, langObj);
  });
}
function renderDrawer(){
  const el = document.querySelector('#entity-name.entity-name');
  if(!el) return;
  const langObj = detectLang((el.textContent||'').trim());
  setInlineAfterLabel(el, langObj);
}

try{
  readyThenDetectAndRender('ytd-account-item-renderer #channel-title');
  readyThenDetectAndRender('yt-formatted-string#channel-title');
  readyThenDetectAndRender('#entity-name.entity-name');
}catch{}

let langMoScheduled=false;
const safeKick=()=>{
  if(langMoScheduled) return;
  langMoScheduled=true;
  setTimeout(()=>{
    langMoScheduled=false;
    renderAccountList();
    renderDrawer();
  }, 250);
};
const moTargets=[document.body, document.querySelector('ytd-app')||document.documentElement].filter(Boolean);
const langMo=new MutationObserver(safeKick);
moTargets.forEach(t=>langMo.observe(t,{childList:true,subtree:true}));
setInterval(safeKick, 3500);

})();
