// ==UserScript==
// @name         YouTube Studio Stats Extractor (v2.6 Auto Collect Fix)
// @namespace    http://tampermonkey.net/
// @version      2.7.2
// @description  Автоматичний збір даних з вкладок Overview + Content, імітація кліків, два модальні вікна, окремі режими надсилання
// @author       Юля
// @match        https://studio.youtube.com/*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      script.google.com
// ==/UserScript==

(function () {
    'use strict';

    let overviewDataTemp = '';
    let contentDataTemp = '';
    let forceCollect = false;
    let redirectedFromWrongTab = false;
    let totalVideos = '';

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
        if (raw.includes('тыс') || raw.includes('тис')) value = Math.round(value * 1000);
        return value;
    }

    function startCombinedDataCollection(startingFromButton = false) {
        const currentPath = window.location.pathname;
        console.log('📍 startCombinedDataCollection | path:', currentPath);
        console.log('📍 startingFromButton:', startingFromButton, '| forceCollect:', forceCollect);

        if (currentPath.includes('/tab-overview/')) {
            console.log('📘 На вкладці Overview');
            extractOverviewData(() => {
                console.log('➡️ Переходимо до Content');
                clickContentTab();
            });
        } else if (currentPath.includes('/tab-content/')) {
            console.log('📘 На вкладці Content');
            extractContentDataAndSend();
        } else if (startingFromButton || forceCollect) {
            console.log('🔁 Переходимо на вкладку Analytics');
            clickAnalyticsTab();
        } else {
            console.log('⏹ Умова не виконалась, збір не почався');
        }
    }

    function waitForElement(selector, callback, logStep = '') {
        const checkExist = setInterval(() => {
            const el = document.querySelector(selector);
            if (el) {
                clearInterval(checkExist);
                console.log('✅ Знайдено елемент:', selector, logStep);
                callback(el);
            } else {
                console.log('⏳ Очікуємо елемент:', selector, logStep);
            }
        }, 500);
    }

    function clickAnalyticsTab() {
        waitForElement('#menu-paper-icon-item-2', (menuItem) => {
            console.log('📌 Клік на Analytics');
            forceCollect = true;
            menuItem.click();
            console.log('🕓 Очікуємо редирект або вже активну вкладку Overview');
const waitForRedirect = setInterval(() => {
    if (window.location.pathname.includes('/tab-overview/')) {
        clearInterval(waitForRedirect);
        console.log('🔄 Уже на вкладці Overview, запускаємо старт');
        redirectedFromWrongTab = true;
    }
}, 500);
        }, '[step: clickAnalyticsTab]');
    }

    const locationCheck = setInterval(() => {
        const path = window.location.pathname;
        if (redirectedFromWrongTab && path.includes('/tab-overview/')) {
            console.log('🔄 Редирект завершено, стартуємо збір');
            redirectedFromWrongTab = false;
            setTimeout(() => {
                startCombinedDataCollection(true);
            }, 1500);
        }
    }, 1000);

    function clickContentTab() {
        waitForElement('#content', (contentTab) => {
            console.log('📌 Клік на Content');
            contentTab.click();
            waitForElement('#metric-total', () => {
                console.log('⏳ Знайдено блок #metric-total, чекаємо 3 секунди на прогрузку даних...');
                    setTimeout(() => {
                    extractContentDataAndSend();
                    }, 3000); // 3000 мс = 3 секунди
                }, '[step: після клік на Content]');
        }, '[step: clickContentTab]');
    }

    function clickLeftSidebarContentTab(callback) {
        const selector = '#menu-paper-icon-item-1';
        waitForElement(selector, (contentTab) => {
            console.log('📌 Клік у лівому меню на Content');
            contentTab.click();
            setTimeout(() => {
                if (typeof callback === 'function') callback();
            }, 1500);
        }, '[step: клік по menu-paper-icon-item-1]');
    }
function goToVideosAndExtractCount(contentMetrics) {
    const selector = '#menu-paper-icon-item-1';
    waitForElement(selector, (contentTab) => {
        console.log('📌 Переходимо на сторінку /videos для збору кількості відео');
        contentTab.click();
        waitForElement('.page-description', () => {
            const el = document.querySelector('.page-description');
            if (!el) {
                console.warn('⚠️ .page-description не знайдено');
                return;
            }

            const text = el.textContent.trim();
            const match = text.match(/(?:из|of)\s*(\d+)/i);
            if (!match || !match[1]) {
                console.warn('⚠️ Не вдалось розпізнати кількість відео');
                return;
            }

            const total = parseInt(match[1].replace(/\s/g, ''), 10);
            console.log('🎞 Загальна кількість відео:', total);

            // формуємо contentDataTemp з totalVideos
            const channelName = overviewDataTemp.split(';')[0] || 'Channel';
            contentDataTemp = `${channelName};${contentMetrics.impressions};${contentMetrics.ctr};${contentMetrics.avgViewDuration};${contentMetrics.dateRange};${total}`;

            // надсилаємо обидва
            showModal('📊 Overview Data', overviewDataTemp);
            showModal('📺 Content Data', contentDataTemp);

            sendToSheet(overviewDataTemp, 'overview');
            sendToSheet(contentDataTemp, 'content');
        }, '[step: page-description]');
    }, '[step: клік у лівому меню]');
}

function extractTotalVideosCount(callback) {
    waitForElement('.page-description', (el) => {
        const text = el.textContent.trim();
        const match = text.match(/(?:из|of)\s*(\d+)/i);
        if (match && match[1]) {
            const total = parseInt(match[1].replace(/\s/g, ''), 10);
            console.log('📦 Всього відео на каналі:', total);
            if (typeof callback === 'function') callback(total);
        } else {
            console.warn('⚠️ Не вдалось розпізнати кількість відео');
            if (typeof callback === 'function') callback('');
        }
    }, '[step: extractTotalVideosCount]');
}

   function extractOverviewData(callback) {
    waitForElement('.metric-value.style-scope.yta-latest-activity-card', () => {
        try {
            console.log('📊 Збір overview-даних...');
            const metricElems = document.querySelectorAll('.metric-value.style-scope.yta-latest-activity-card');
            const views48h = parseNumber(metricElems[0]?.textContent || '0');
            const subscribers = parseNumber(metricElems[1]?.textContent || '0');

            const totals = Array.from(document.querySelectorAll('#metric-total'))
                .map(el => el.textContent.trim());

            const viewsPeriod = parseNumber(totals[0] || '0');
            const hoursPeriod = parseNumber(totals[1] || '0');

            const channelName = document.querySelector('#entity-name.entity-name')?.textContent.trim() || 'Без назви';
            const dateRange = new Date().toLocaleDateString('uk-UA');

            // 💾 БЕЗ totalVideos поки що — він додасться пізніше
            overviewDataTemp = `${channelName};${dateRange};${views48h};${viewsPeriod};${hoursPeriod};${subscribers}`;

            console.log('📦 Overview:', overviewDataTemp);

            if (typeof callback === 'function') callback();
        } catch (e) {
            alert('❌ Помилка при зчитуванні overview-даних: ' + e.message);
        }
    }, '[step: extractOverviewData]');
}

function extractTotalVideosCount() {
    const paginatorSpan = document.querySelector('ytcp-paginator span');
    if (!paginatorSpan) {
        console.warn('⚠️ Не знайдено paginator span');
        return '';
    }

    const text = paginatorSpan.textContent.trim();
    const match = text.match(/(?:із|of)\s+(\d+)/i);
    if (match && match[1]) {
        const total = parseInt(match[1].replace(/\s/g, ''), 10);
        return isNaN(total) ? '' : total;
    }
    return '';
}

function extractContentDataAndSend() {
    try {
        console.log('📊 Збір content-даних...');
        const totals = Array.from(document.querySelectorAll('#metric-total'))
            .map(el => el.textContent.trim());

        const views = parseNumber(totals[0] || '');
        const impressions = parseNumber(totals[1] || '');
        const ctr = parseNumber(totals[2] || '');
        const avgViewDuration = parseNumber(totals[3] || '');

        const dateRange = new Date().toLocaleDateString('uk-UA');

        // тимчасово зберігаємо ці дані
        const contentMetrics = { impressions, ctr, avgViewDuration, dateRange };

        // йдемо далі за totalVideos
        goToVideosAndExtractCount(contentMetrics);

    } catch (e) {
        alert('❌ Помилка при зчитуванні content-даних: ' + e.message);
    }
}


    function showModal(title, data) {
        const modal = document.createElement('div');
        modal.style = `
            position: fixed;
            top: 20%;
            left: 50%;
            transform: translateX(-50%);
            background: #202020;
            color: white;
            padding: 20px;
            border-radius: 8px;
            z-index: 99999;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
            font-family: sans-serif;
            max-width: 90%;
        `;

        const closeButton = document.createElement('div');
        closeButton.textContent = '✖';
        closeButton.style = `
            position: absolute;
            top: 8px;
            right: 10px;
            cursor: pointer;
            font-size: 16px;
        `;
        closeButton.onclick = () => modal.remove();

        const heading = document.createElement('div');
        heading.textContent = title;
        heading.style = 'font-weight: bold; margin-bottom: 10px; font-size: 18px;';

        const text = document.createElement('div');
        text.textContent = data;
        text.style = 'margin-bottom: 10px; font-size: 16px; word-break: break-word;';

        const copyButton = document.createElement('button');
        copyButton.textContent = '📋 Копіювати';
        copyButton.style = `
            background-color: #3ea6ff;
            color: white;
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
        `;
        copyButton.onclick = () => {
            GM_setClipboard(data);
            copyButton.textContent = '✅ Скопійовано!';
            setTimeout(() => copyButton.textContent = '📋 Копіювати', 2000);
        };

        modal.appendChild(closeButton);
        modal.appendChild(heading);
        modal.appendChild(text);
        modal.appendChild(copyButton);
        document.body.appendChild(modal);

        setTimeout(() => {
            modal.remove();
        }, 15000);
    }

    function sendToSheet(value, mode) {
        GM_xmlhttpRequest({
            method: 'POST',
            url: 'https://script.google.com/macros/s/AKfycbyd0aMl6ZomWyWtNbzxMikqfYVq2RTArD0z97eyVaWWa3zDeLOk0qALtIkiseI393lS/exec',
            headers: {
                'Content-Type': 'application/json'
            },
            data: JSON.stringify({ mode: mode, value: value })
        });
    }
})();
