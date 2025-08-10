// ==UserScript==
// @name         YouTube Studio Stats Extractor (v2.6 Auto Collect Fix)
// @namespace    http://tampermonkey.net/
// @version      2.7.14
// @description  Автоматичний збір даних з вкладок Overview + Content, статуси в кнопці, одна відправка (UTC), порядок полів за ТЗ, конвертація тыс/млн у числа з логом у консоль
// @author       Вадим
// @match        https://studio.youtube.com/*
// @updateURL    https://raw.githubusercontent.com/vavavavavava/pa/main/YouTube%20Studio%20Stats%20Extractor%20(v2.6%20Auto%20Collect%20Fix)-2.7.1.user.js
// @downloadURL  https://raw.githubusercontent.com/vavavavavava/pa/main/YouTube%20Studio%20Stats%20Extractor%20(v2.6%20Auto%20Collect%20Fix)-2.7.1.user.js
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      script.google.com
// ==/UserScript==

(function () {
  'use strict';

  function getExtractButton() { return document.querySelector('#extract-button'); }
  function setButtonStatus(text) { const btn = getExtractButton(); if (btn) btn.textContent = text; }

  let overviewChannel = '';
  let overviewDateUTC = '';
  let oViews48h = '';
  let oViewsPeriod = '';
  let oHoursPeriod = '';
  let oSubscribers = '';

  let contentDateUTC = '';
  let forceCollect = false;
  let redirectedFromWrongTab = false;

  console.log('🟢 Скрипт завантажено');

// ========================
// UI helpers & static actions (added)
// ========================

// Robust removal of the "Sign out" menu item in the account menu.
// Strategy: find any ytd-compact-link-renderer that contains a #subtitle with text "Вийти" or "Sign out" and remove the renderer entirely.
// Надійне видалення "Вийти" тільки в меню акаунта
function removeSignOutMenuItem() {
  try {
    // працюємо лише в контейнері попап-меню, щоб випадково не зачепити інші елементи
    const menus = document.querySelectorAll('ytd-popup-container, tp-yt-paper-dialog, ytd-multi-page-menu-renderer');
    menus.forEach(root => {
      const link = root.querySelector(
        'a[href*="/logout"], a[href^="https://www.youtube.com/logout"], a[href^="https://accounts.google.com/Logout"]'
      );
      if (link) {
        const item = link.closest('ytd-compact-link-renderer, tp-yt-paper-item');
        if (item) {
          item.remove();
          console.log('🗑️ Видалено пункт меню "Вийти" (за посиланням logout)');
        }
      }
    });
  } catch (e) {
    console.warn('removeSignOutMenuItem error:', e);
  }
}

// спрацьовує коли меню рендериться/оновлюється
const signOutObserver = new MutationObserver(() => removeSignOutMenuItem());
signOutObserver.observe(document.body, { childList: true, subtree: true });
// перший прохід
removeSignOutMenuItem();

// Fallback: add a floating action button for data extraction in case header selectors change
function ensureFloatingExtractButton() {
  if (document.querySelector('#extract-button')) return; // already exists (header version)
  if (document.querySelector('#extract-button-fab')) return; // floating already exists

  const fab = document.createElement('button');
  fab.id = 'extract-button-fab';
  fab.textContent = '📊 Дані';
  Object.assign(fab.style, {
    position: 'fixed',
    bottom: '16px',
    left: '16px',
    zIndex: '2147483647',
    padding: '10px 14px',
    fontWeight: 'bold',
    borderRadius: '8px',
    border: 'none',
    cursor: 'pointer',
  });
  fab.style.backgroundColor = '#3ea6ff';
  fab.style.color = '#ffffff';

  // Reuse the same behavior as main button
  fab.addEventListener('click', () => {
    try {
      console.log('🟡 Клік по FAB "Дані"');
      setButtonStatus && setButtonStatus('📊 Дані');
      forceCollect = true;
      redirectedFromWrongTab = false;
      startCombinedDataCollection(true);
    } catch (e) {
      console.warn('FAB click error:', e);
    }
  });

  document.body.appendChild(fab);
  console.log('➕ Додано плаваючу кнопку "Дані"');
}

// Watch for header presence but always ensure FAB exists as a fallback
const fabObserver = new MutationObserver(() => ensureFloatingExtractButton());
fabObserver.observe(document.body, { childList: true, subtree: true });
// First pass on load
ensureFloatingExtractButton();

  const observer = new MutationObserver(() => {
    let headerContainer = document.querySelector('#right-section-content')
                       || document.querySelector('#right-section')
                       || document.querySelector('#right-content')
                       || document.querySelector('ytcp-header #right')
                       || document.querySelector('ytcp-header #right-container');
    if (headerContainer && !document.querySelector('#extract-button')) {
      console.log('🔘 Інжект кнопки...');
      injectButton(headerContainer);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  function injectButton(container) {
    const button = document.createElement('button');
    button.textContent = '📊 Дані';
    button.id = 'extract-button';
    button.style = `
      margin-left: 10px;
      background-color: #3ea6ff;
      color: white;
      border: none;
      padding: 6px 12px;
      font-weight: bold;
      border-radius: 4px;
      cursor: pointer;
    `;
    button.onclick = () => {
      console.log('🟡 Клік по кнопці "Дані"');
      setButtonStatus('📊 Дані');
      forceCollect = true;
      redirectedFromWrongTab = false;
      startCombinedDataCollection(true);
    };
    container.appendChild(button);
  }

  function parseNumber(text) {
    if (!text) return '';
    const raw = text.replace(/\s/g, '').replace(',', '.').toLowerCase();
    if (raw.includes('%') || raw.match(/^\d+:\d+/)) return raw;

    let value = parseFloat(raw);
    if (isNaN(value)) return '';

    // Конвертація тисяч
    if (raw.includes('тыс') || raw.includes('тис') || raw.includes('k')) {
      console.log(`🔢 Конвертую значення з тисяч у число: ${value}k -> ${value * 1000}`);
      value = Math.round(value * 1000);
    }

    // Конвертація мільйонів
    if (raw.includes('млн') || raw.includes('million') || raw.includes('mln') || raw.includes('мільй')) {
      console.log(`🔢 Конвертую значення з мільйонів у число: ${value}M -> ${value * 1000000}`);
      value = Math.round(value * 1000000);
    }

    return value;
  }

  function startCombinedDataCollection(startingFromButton = false) {
    const currentPath = window.location.pathname;
    if (currentPath.includes('/tab-overview/')) {
      extractOverviewData(() => { clickContentTab(); });
    } else if (currentPath.includes('/tab-content/')) {
      extractContentDataAndSend();
    } else if (startingFromButton || forceCollect) {
      clickAnalyticsTab();
    }
  }

  function waitForElement(selector, callback, logStep = '') {
    const checkExist = setInterval(() => {
      const el = document.querySelector(selector);
      if (el) { clearInterval(checkExist); callback(el); }
    }, 500);
  }

  function clickAnalyticsTab() {
    waitForElement('#menu-paper-icon-item-2', (menuItem) => {
      forceCollect = true;
      menuItem.click();
      const waitForRedirect = setInterval(() => {
        if (window.location.pathname.includes('/tab-overview/')) {
          clearInterval(waitForRedirect);
          redirectedFromWrongTab = true;
        }
      }, 500);
    });
  }

  const locationCheck = setInterval(() => {
    const path = window.location.pathname;
    if (redirectedFromWrongTab && path.includes('/tab-overview/')) {
      redirectedFromWrongTab = false;
      setTimeout(() => { startCombinedDataCollection(true); }, 1500);
    }
  }, 1000);

  function clickContentTab() {
    waitForElement('#content', (contentTab) => {
      contentTab.click();
      waitForElement('#metric-total', () => {
        let remain = 3;
        setButtonStatus(`⏱️ Контент [${remain}s]`);
        const cntInt = setInterval(() => {
          remain--;
          if (remain > 0) setButtonStatus(`⏱️ Контент [${remain}s]`);
          else clearInterval(cntInt);
        }, 1000);
        setTimeout(() => { extractContentDataAndSend(); }, 3000);
      });
    });
  }

  function goToVideosAndExtractCount(contentMetrics) {
    const selector = '#menu-paper-icon-item-1';
    waitForElement(selector, (contentTab) => {
      contentTab.click();
      waitForElement('.page-description', () => {
        const el = document.querySelector('.page-description');
        if (!el) return;
        const rawText = el.textContent || '';
        const cleanedText = rawText.trim().replace(/\u00A0/g, ' ');
        const match = cleanedText.match(/(?:из|of|з)\s*(?:примерно|approximately)?\s*(\d+)/i);
        if (!match || !match[1]) return;
        const total = parseInt(match[1].replace(/\s/g, ''), 10);
        if (isNaN(total)) return;

        const combinedData =
  `${overviewChannel};${overviewDateUTC};${oSubscribers};${oViewsPeriod};${oHoursPeriod};${oViews48h};${overviewChannel};` +
  `${contentMetrics.impressions};${contentMetrics.ctr}${'\u200B'};${contentMetrics.avgViewDuration}${'\u200B'};${contentDateUTC};${total}`;


        console.log('📦 Об’єднані дані для відправки:', combinedData);
        setButtonStatus('✅ Контент');
        setButtonStatus('✉️ Відправка');
        sendToSheet(combinedData, 'combined');
        setButtonStatus('✅ Готово');
      });
    });
  }

  function extractOverviewData(callback) {
    waitForElement('.metric-value.style-scope.yta-latest-activity-card', () => {
      try {
        const metricElems = document.querySelectorAll('.metric-value.style-scope.yta-latest-activity-card');
        const subscribers = parseNumber(metricElems[0]?.textContent || '0');
        const views48h   = parseNumber(metricElems[1]?.textContent || '0');

        const totals = Array.from(document.querySelectorAll('#metric-total')).map(el => el.textContent.trim());
        const viewsPeriod  = parseNumber(totals[0] || '0');
        const hoursPeriod  = parseNumber(totals[1] || '0');

        overviewChannel = document.querySelector('#entity-name.entity-name')?.textContent.trim() || 'Без назви';
        overviewDateUTC = new Date().toISOString().split('T')[0];

        oViews48h    = views48h;
        oViewsPeriod = viewsPeriod;
        oHoursPeriod = hoursPeriod;
        oSubscribers = subscribers;

        setButtonStatus('✅ Загальна');
        if (typeof callback === 'function') callback();
      } catch (e) {
        setButtonStatus('❌ Помилка');
      }
    });
  }

  function extractContentDataAndSend() {
    try {
      const totals = Array.from(document.querySelectorAll('#metric-total')).map(el => el.textContent.trim());
      const impressions      = parseNumber(totals[1] || '');
      const ctr              = parseNumber(totals[2] || '');
      const avgViewDuration  = parseNumber(totals[3] || '');
      contentDateUTC = new Date().toISOString().split('T')[0];
      const contentMetrics = { impressions, ctr, avgViewDuration };
      goToVideosAndExtractCount(contentMetrics);
    } catch (e) {
      setButtonStatus('❌ Помилка');
    }
  }

  function sendToSheet(value, mode) {
    GM_xmlhttpRequest({
      method: 'POST',
      url: 'https://script.google.com/macros/s/AKfycbyd0aMl6ZomWyWtNbzxMikqfYVq2RTArD0z97eyVaWWa3zDeLOk0qALtIkiseI393lS/exec',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ mode: mode, value: value })
    });
  }
})();
