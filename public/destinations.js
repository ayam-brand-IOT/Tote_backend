// Shared destinations — single source of truth for all station pages
const DESTINATIONS = [
  'FACTORY_1',
  'FACTORY_2',
  'FACTORY_3',
  'FACTORY_4',
  'FACTORY_5',
  'FACTORY_6',
  'FACTORY_7',
  'FACTORY_8',
];

function buildDestinationSelect(el, { includeBlank = true, blankLabel = '— Select destination —' } = {}) {
  if (typeof el === 'string') el = document.getElementById(el);
  if (!el) return;
  el.innerHTML =
    (includeBlank ? `<option value="">${blankLabel}</option>` : '') +
    DESTINATIONS.map(d => `<option value="${d}">${d.replace('_', ' ')}</option>`).join('');
}
