// ==UserScript==
// @name         GeoGuessr Score Rings Visualizer
// @namespace    https://miraclewhips.dev/
// @version      2.1.0
// @description  Draws score distance rings around map pins during non-competitive GeoGuessr rounds.
// @author       Theia
// @match        *://*.geoguessr.com/*
// @run-at       document-idle
// @icon         https://www.google.com/s2/favicons?domain=geoguessr.com
// @grant        unsafeWindow
// @copyright    2026, Theia
// @license      MIT
// @downloadURL  https://github.com/andy-theia/georings/blob/main/geoguessr-score-rings.user.js
// @updateURL    https://github.com/andy-theia/georings/blob/main/geoguessr-score-rings.user.js
// ==/UserScript==

(function () {
    'use strict';

    if (window.frameElement) return;

    let currentMapScaleD = 18534781; // Fallback default (ACW)
    let currentRound = null;
    let MAP_INSTANCES = [];
    let activeCircles = [];

    const ringConfigs = [
        { score: 5000, color: '#dc3545' },
        { score: 4000, color: '#fd7e14' },
        { score: 3000, color: '#ffc107' },
        { score: 2000, color: '#28a745' },
        { score: 1000, color: '#007bff' },
        { score: 500,  color: '#6f42c1' },
        { score: 0,    color: '#000000' }
    ];

    // Check if current URL corresponds to a competitive, daily, or streak mode
    function isUnsupportedGameMode() {
        const path = window.location.pathname.toLowerCase();
        return (
            path.includes('/duels') ||
            path.includes('/daily-challenge') ||
            path.includes('/streak') ||
            path.includes('/competitive') ||
            path.includes('/multiplayer') ||
            path.includes('/bullseye')
        );
    }

    function logScaleUpdate(newD, source) {
        if (newD && newD > 0 && newD !== currentMapScaleD) {
            currentMapScaleD = newD;
            console.log(`[Score Rings] Scale Factor (D) updated to: ${currentMapScaleD.toLocaleString()} m (Source: ${source})`);
        }
    }

    function findMaxErrorDistance(obj) {
        if (!obj || typeof obj !== 'object') return null;
        if (typeof obj.maxErrorDistance === 'number' && obj.maxErrorDistance > 0) {
            return obj.maxErrorDistance;
        }
        for (const key of Object.keys(obj)) {
            try {
                const found = findMaxErrorDistance(obj[key]);
                if (found) return found;
            } catch (e) {
                // Ignore circular reference errors
            }
        }
        return null;
    }

    function clearRings() {
        for (const circle of activeCircles) {
            circle.setMap(null);
        }
        activeCircles = [];
    }

    // --- 1. Check Hydrated Next.js State for preloaded map data ---
    function checkNextDataState() {
        if (isUnsupportedGameMode()) return;
        const nextDataEl = document.getElementById('__NEXT_DATA__');
        if (nextDataEl) {
            try {
                const parsed = JSON.parse(nextDataEl.textContent);
                const extractedD = findMaxErrorDistance(parsed);
                if (extractedD) {
                    logScaleUpdate(extractedD, "__NEXT_DATA__");
                }
            } catch (e) {}
        }
    }

    // --- 2. Intercept Fetch Requests ---
    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const originalFetch = win.fetch;
    win.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);
        if (isUnsupportedGameMode()) {
            clearRings();
            return response;
        }

        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

        if (url.includes('/api/v3/') || url.includes('/api/maps/')) {
            const clone = response.clone();
            clone.json().then(data => {
                if (data) {
                    const extractedD = findMaxErrorDistance(data);
                    if (extractedD) logScaleUpdate(extractedD, "Fetch API");

                    if (data.round && data.round !== currentRound) {
                        currentRound = data.round;
                        clearRings();
                    }
                }
            }).catch(() => {});
        }
        return response;
    };

    // --- 3. Intercept XMLHttpRequest (XHR) ---
    const originalXHR = win.XMLHttpRequest.prototype.open;
    win.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.addEventListener('load', function () {
            if (isUnsupportedGameMode()) {
                clearRings();
                return;
            }

            if (typeof url === 'string' && (url.includes('/api/v3/') || url.includes('/api/maps/'))) {
                try {
                    const data = JSON.parse(this.responseText);
                    const extractedD = findMaxErrorDistance(data);
                    if (extractedD) logScaleUpdate(extractedD, "XHR");

                    if (data && data.round && data.round !== currentRound) {
                        currentRound = data.round;
                        clearRings();
                    }
                } catch (e) {}
            }
        });
        return originalXHR.apply(this, [method, url, ...rest]);
    };

    // --- Ring & Geometry Logic ---
    function calculateRadius(targetScore) {
        if (targetScore >= 5000) return currentMapScaleD / 100000;
        const scoreVal = (targetScore === 0) ? 0.5 : targetScore;
        return -1 * (currentMapScaleD / 10) * Math.log(scoreVal / 5000);
    }

    function drawRings(mapInstance, latLng) {
        clearRings();

        if (isUnsupportedGameMode()) return;

        const google = win.google;
        if (!google || !google.maps) return;

        ringConfigs.forEach(ring => {
            const radiusMeters = calculateRadius(ring.score);

            const circle = new google.maps.Circle({
                strokeColor: ring.color,
                strokeOpacity: 0.85,
                strokeWeight: 2,
                fillOpacity: 0.0,
                map: mapInstance,
                center: latLng,
                radius: radiusMeters,
                clickable: false
            });

            activeCircles.push(circle);
        });
    }

    // --- 4. Global UI Click Listener for Round Transitions ---
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('button, [data-qa]');
        if (!btn) return;

        const text = (btn.textContent || '').toLowerCase();
        const qa = (btn.getAttribute('data-qa') || '').toLowerCase();

        // Clear rings when clicking key UI actions
        if (
            text.includes('next round') ||
            text.includes('view summary') ||
            text.includes('view breakdown') ||
            text.includes('play again') ||
            qa.includes('close-round-result') ||
            qa.includes('perform-guess')
        ) {
            clearRings();
        }
    }, true);

    // --- Attach Google Maps Click Listener ---
    function initMapHooks() {
        checkNextDataState();

        const interval = setInterval(() => {
            const google = win.google;
            if (google && google.maps && google.maps.Map) {
                clearInterval(interval);

                const OriginalMap = google.maps.Map;
                google.maps.Map = class extends OriginalMap {
                    constructor(...args) {
                        super(...args);
                        MAP_INSTANCES.push(this);

                        this.addListener('click', (e) => {
                            if (isUnsupportedGameMode()) {
                                clearRings();
                                return;
                            }

                            if (e && e.latLng) {
                                drawRings(this, e.latLng);
                            }
                        });
                    }
                };
            }
        }, 100);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initMapHooks);
    } else {
        initMapHooks();
    }
})();
