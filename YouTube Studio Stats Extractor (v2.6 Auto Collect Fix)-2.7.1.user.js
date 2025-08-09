// ==UserScript==
// @name         YouTube Studio Stats Extractor (v2.6 Auto Collect Fix)
// @namespace    http://tampermonkey.net/
// @version      2.7.12
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

  const observer = new MutationObserver(() => {
    const headerContainer = document.querySelector('#right-section-content');
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
        const match = cleanedText.match(/(?:из|of)\s*(?:примерно|approximately)?\s*(\d+)/i);
        if (!match || !match[1]) return;
        const total = parseInt(match[1].replace(/\s/g, ''), 10);
        if (isNaN(total)) return;

        const combinedData =
          `${overviewChannel};${overviewDateUTC};${oSubscribers};${oViewsPeriod};${oHoursPeriod};${oViews48h};${overviewChannel};` +
          `${contentMetrics.impressions};${contentMetrics.ctr};${contentMetrics.avgViewDuration};${contentDateUTC};${total}`;

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
