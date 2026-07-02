// Shared destinations — single source of truth for all station pages
// Keep in sync with FACTORIES in tote-frontend/src/constants/options.js
const DESTINATIONS = [
  'F1',
  'F2A',
  'F2C',
  'F2B',
];

function buildDestinationSelect(el, { includeBlank = true, blankLabel = '— Select destination —' } = {}) {
  if (typeof el === 'string') el = document.getElementById(el);
  if (!el) return;
  el.innerHTML =
    (includeBlank ? `<option value="">${blankLabel}</option>` : '') +
    DESTINATIONS.map(d => `<option value="${d}">${d}</option>`).join('');
}
