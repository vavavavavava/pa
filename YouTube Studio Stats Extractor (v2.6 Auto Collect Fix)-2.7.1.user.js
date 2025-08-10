// ==UserScript==
// @name         YouTube Studio Stats Extractor (No FAB, Remove Logout)
// @namespace    http://tampermonkey.net/
// @version      2.7.14
// @description  Автоматичний збір даних з вкладок Overview + Content, видалення кнопки "Вийти" та стабільний інжект кнопки "Дані"
// @match        https://studio.youtube.com/*
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

  // --- Видалення кнопки "Вийти" по посиланню logout ---
  function removeSignOutMenuItem() {
    try {
      const link = document.querySelector(
        'ytd-compact-link-renderer a[href*="/logout"], a[href^="https://www.youtube.com/logout"], a[href^="https://accounts.google.com/Logout"]'
      );
      if (link) {
        const parentItem = link.closest('ytd-compact-link-renderer, tp-yt-paper-item');
        if (parentItem) {
          parentItem.remove();
          console.log('🗑️ Видалено пункт меню "Вийти"');
        }
      }
    } catch (e) {
      console.warn('removeSignOutMenuItem error:', e);
    }
  }
  const signOutObserver = new MutationObserver(() => removeSignOutMenuItem());
  signOutObserver.observe(document.body, { childList: true, subtree: true });
  removeSignOutMenuItem();

  // --- Стабільний інжект кнопки в хедер ---
  const HEADER_SELECTORS = [
    '#right-section-content',
    'ytcp-header #right',
    'ytcp-header #right-section',
    'ytcp-header #right-container',
    '#right-section',
    '#right-content'
  ];
  function findHeaderContainer() {
    for (const q of HEADER_SELECTORS) {
      const el = document.querySelector(q);
      if (el) return el;
    }
    return null;
  }
  function ensureHeaderButton() {
    if (document.querySelector('#extract-button')) return;
    const container = findHeaderContainer();
    if (!container) return;
    const button = document.createElement('button');
    button.textContent = '📊 Дані';
    button.id = 'extract-button';
    button.style.cssText = `
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
    console.log('🔘 Інжектовано кнопку в хедер');
  }
  ensureHeaderButton();
  const headerObserver = new MutationObserver(() => ensureHeaderButton());
  headerObserver.observe(document.body, { childList: true, subtree: true });

  // --- Основна логіка збору ---
  function parseNumber(text) {
    if (!text) return '';
    const raw = text.replace(/\s/g, '').replace(',', '.').toLowerCase();
    if (raw.includes('%') || raw.match(/^\d+:\d+/)) return raw;
    let value = parseFloat(raw);
    if (isNaN(value)) return '';
    if (raw.includes('тыс') || raw.includes('тис') || raw.includes('k')) value = Math.round(value * 1000);
    if (raw.includes('млн') || raw.includes('million') || raw.includes('mln') || raw.includes('мільй')) value = Math.round(value * 1000000);
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

  function waitForElement(selector, callback) {
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
        setTimeout(() => { extractContentDataAndSend(); }, 3000);
      });
    });
  }

  function goToVideosAndExtractCount(contentMetrics) {
    waitForElement('#menu-paper-icon-item-1', (contentTab) => {
      contentTab.click();
      waitForElement('.page-description', () => {
        const el = document.querySelector('.page-description');
        if (!el) return;
        const rawText = el.textContent || '';
        const match = rawText.match(/(?:из|of|з)\s*(?:примерно|approximately)?\s*(\d+)/i);
        if (!match || !match[1]) return;
        const total = parseInt(match[1].replace(/\s/g, ''), 10);
        if (isNaN(total)) return;
        const combinedData =
          `${overviewChannel};${overviewDateUTC};${oSubscribers};${oViewsPeriod};${oHoursPeriod};${oViews48h};${overviewChannel};` +
          `${contentMetrics.impressions};${contentMetrics.ctr}${'\u200B'};${contentMetrics.avgViewDuration}${'\u200B'};${contentDateUTC};${total}`;
        console.log('📦 Об’єднані дані для відправки:', combinedData);
        setButtonStatus('✅ Контент');
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
        const views48h = parseNumber(metricElems[1]?.textContent || '0');
        const totals = Array.from(document.querySelectorAll('#metric-total')).map(el => el.textContent.trim());
        const viewsPeriod = parseNumber(totals[0] || '0');
        const hoursPeriod = parseNumber(totals[1] || '0');
        overviewChannel = document.querySelector('#entity-name.entity-name')?.textContent.trim() || 'Без назви';
        overviewDateUTC = new Date().toISOString().split('T')[0];
        oViews48h = views48h;
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
      const impressions = parseNumber(totals[1] || '');
      const ctr = parseNumber(totals[2] || '');
      const avgViewDuration = parseNumber(totals[3] || '');
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
