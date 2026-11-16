// Demo data generator for the manager dashboard.
//
// Populates ~4 weeks of realistic production history so the line-productivity
// dashboard, charts and live board have something to show. Safe to re-run: it
// clears totes / links / assignments / products first, then regenerates.
//
//   node seed.js            # ~28 days of history
//   DAYS=14 node seed.js    # custom window
//
// It does NOT drop tables (use init-db.js for that). It reuses / ensures the
// production lines and rebuilds everything that hangs off them.

require('dotenv').config();
const db = require('./db');

// ── Deterministic RNG so re-runs produce comparable-looking data ───────────
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260709);
const rand = (min, max) => min + rng() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const pick = (arr) => arr[Math.floor(rng() * arr.length)];

// ── Fixed vocabularies (mirror src/constants/options.js) ───────────────────
const FISH_TYPES = ['1 (HCT)', '2 (H&T)', '3 (WR)'];
const FISH_SIZES = ['Jitney', 'Buffet', 'Tower', 'Tall', 'Small Oval', 'Big Oval', 'CC', 'Fried Fish'];
const FACTORIES = ['F1', 'F2A', 'F2C', 'F2B'];
const ORIGINS = ['Pacific', 'Indian Ocean', 'Atlantic', 'Banda Sea', 'Local'];

// Lines the plant runs. The first three mirror the app defaults; two extra
// give the dashboard a fuller comparison. Each has a throughput personality.
const LINES = [
  { line_id: 'Hybrid',    weight: 1.25, comment: 'High-throughput hybrid line' },
  { line_id: 'Taichong',  weight: 1.0,  comment: 'Steady mid-volume line' },
  { line_id: 'Mexican',   weight: 0.8,  comment: 'Specialty / smaller runs' },
  { line_id: 'Kaohsiung', weight: 1.1,  comment: 'Export-grade line' },
  { line_id: 'Delta',     weight: 0.65, comment: 'Backup / overflow line' },
];

const PRODUCTS = [
  { product: 'Skipjack Loin',   type: '1 (HCT)', size: 'Tower',      origin: 'Pacific' },
  { product: 'Yellowfin Saku',  type: '2 (H&T)', size: 'Big Oval',   origin: 'Indian Ocean' },
  { product: 'Albacore Steak',  type: '3 (WR)',  size: 'Tall',       origin: 'Atlantic' },
  { product: 'Bonito Fillet',   type: '2 (H&T)', size: 'Buffet',     origin: 'Banda Sea' },
  { product: 'Tuna Chunk',      type: '1 (HCT)', size: 'Small Oval', origin: 'Pacific' },
  { product: 'Katsuo Block',    type: '1 (HCT)', size: 'CC',         origin: 'Local' },
  { product: 'Yellowfin Loin',  type: '2 (H&T)', size: 'Jitney',     origin: 'Indian Ocean' },
  { product: 'Tuna Flake',      type: '3 (WR)',  size: 'Fried Fish', origin: 'Atlantic' },
];

const DAYS = parseInt(process.env.DAYS || '28', 10);

// MySQL DATETIME formatter (local time, matches CURRENT_TIMESTAMP semantics).
function fmt(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function seed() {
  console.log(`Seeding ${DAYS} days of demo production data...`);

  // 1. Clear derived data (children first for FK safety). Lines are kept/ensured.
  await db.query('DELETE FROM tote_line');
  await db.query('DELETE FROM line_product');
  await db.query('DELETE FROM totes');
  await db.query('DELETE FROM products');
  await db.query('ALTER TABLE totes AUTO_INCREMENT = 1');
  await db.query('ALTER TABLE products AUTO_INCREMENT = 1');

  // 1b. Ensure the physical tote inventory exists (T001..T099). Processing
  //     records reference these — a physical tote is reused across many trips.
  const TOTE_POOL = [];
  for (let i = 1; i <= 99; i++) TOTE_POOL.push(`T${String(i).padStart(3, '0')}`);
  await db.query('INSERT IGNORE INTO tote_assets (tote_id) VALUES ?', [TOTE_POOL.map((t) => [t])]);

  // 2. Ensure lines exist.
  for (const l of LINES) {
    await db.query(
      'INSERT INTO `lines` (line_id, comments) VALUES (?, ?) ON DUPLICATE KEY UPDATE comments = VALUES(comments)',
      [l.line_id, l.comment]
    );
  }

  // 3. Products.
  const productIds = [];
  for (const p of PRODUCTS) {
    const [r] = await db.query(
      'INSERT INTO products (product, type, size, origin, comments) VALUES (?, ?, ?, ?, ?)',
      [p.product, p.type, p.size, p.origin, null]
    );
    productIds.push(r.insertId);
  }

  const now = new Date();
  const startDay = new Date(now);
  startDay.setDate(startDay.getDate() - (DAYS - 1));
  startDay.setHours(0, 0, 0, 0);

  // 4. Build product-assignment periods per line across the window.
  //    Each line rotates product every 5-9 days; the last period stays active
  //    (ended_at NULL) so the dashboard shows a current product.
  const linePeriods = {}; // line_id -> [{ lpId, product_id, destination, start, end }]
  for (const line of LINES) {
    const periods = [];
    let cursor = new Date(startDay);
    let dest = pick(FACTORIES);
    while (cursor < now) {
      const spanDays = randInt(5, 9);
      const end = new Date(cursor);
      end.setDate(end.getDate() + spanDays);
      const isLast = end >= now;
      periods.push({
        product_id: pick(productIds),
        destination: dest,
        start: new Date(cursor),
        end: isLast ? null : new Date(end),
      });
      cursor = end;
      if (rng() < 0.4) dest = pick(FACTORIES); // occasionally change destination
    }
    // Persist assignments and capture their ids.
    for (const period of periods) {
      const [r] = await db.query(
        'INSERT INTO line_product (line_id, product_id, destination, started_at, ended_at, comments) VALUES (?, ?, ?, ?, ?, ?)',
        [line.line_id, period.product_id, period.destination, fmt(period.start), period.end ? fmt(period.end) : null, null]
      );
      period.lpId = r.insertId;
    }
    linePeriods[line.line_id] = periods;
  }

  const lpForTimestamp = (lineId, ts) => {
    const periods = linePeriods[lineId];
    for (const p of periods) {
      if (ts >= p.start && (p.end === null || ts < p.end)) return p;
    }
    return periods[periods.length - 1];
  };

  // 5. Generate totes day by day and link each to its line's active assignment.
  let toteCount = 0;
  for (let d = 0; d < DAYS; d++) {
    const day = new Date(startDay);
    day.setDate(day.getDate() + d);
    const isToday = day.toDateString() === now.toDateString();
    const dow = day.getDay();
    const weekendFactor = dow === 0 ? 0.3 : dow === 6 ? 0.6 : 1; // slower weekends

    for (const line of LINES) {
      const base = 6 * line.weight * weekendFactor;
      const nTotes = Math.max(0, Math.round(base + rand(-1.5, 1.5)));

      for (let i = 0; i < nTotes; i++) {
        // Spread across a 06:00-18:00 shift; today only up to the current hour.
        const shiftEndHour = isToday ? Math.max(7, now.getHours() + now.getMinutes() / 60) : 18;
        const hour = rand(6, shiftEndHour);
        const ts = new Date(day);
        ts.setHours(Math.floor(hour), Math.floor((hour % 1) * 60), randInt(0, 59), 0);
        if (ts > now) continue;

        const period = lpForTimestamp(line.line_id, ts);

        // Inbound weights.
        const tote_kg = randInt(24, 34);
        const ice_kg = randInt(18, 40);
        const water_kg = randInt(8, 22);
        // Fish processed — the headline metric. Scaled by line personality.
        const fish_kg = Math.round(rand(180, 360) * line.weight);
        const raw_kg = tote_kg + ice_kg + water_kg + fish_kg;
        const ice_out_kg = Math.round(ice_kg * rand(0.15, 0.5));
        const water_out_kg = Math.round(water_kg * rand(0.3, 0.7));
        const temp_out = +rand(-1.2, 2.8).toFixed(2);

        // Status: history is fully processed; today walks the lifecycle so the
        // live board and status donut have variety (older = further along).
        let status;
        if (!isToday) {
          status = 'offloaded-to-clean';
        } else {
          const ageH = (now - ts) / 3.6e6;
          if (ageH > 6) status = pick(['offloaded-to-clean', 'received-for-packing']);
          else if (ageH > 4) status = 'in-transit';
          else if (ageH > 2) status = 'outbound-ready';
          else if (ageH > 0.75) status = 'product-linked';
          else status = 'inbound-ready';
        }

        // Reuse a real physical tote from the inventory (traceability).
        const toteLabel = pick(TOTE_POOL);
        const tsStr = fmt(ts);

        const [tr] = await db.query(
          `INSERT INTO totes
            (tote_id, tote_kg, water_kg, ice_kg, fish_kg, raw_kg, ice_out_kg, water_out_kg, temp_out, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [toteLabel, tote_kg, water_kg, ice_kg, fish_kg, raw_kg, ice_out_kg, water_out_kg, temp_out, status, tsStr, tsStr]
        );

        // Link to the line assignment active at processing time.
        await db.query(
          'INSERT INTO tote_line (tote_record_id, line_product_id, destination, linked_at) VALUES (?, ?, ?, ?)',
          [tr.insertId, period.lpId, period.destination, tsStr]
        );
        toteCount += 1;
      }
    }
  }

  console.log(`Done. Inserted ${PRODUCTS.length} products, ${LINES.length} lines, ${toteCount} totes across ${DAYS} days.`);
}

if (require.main === module) {
  seed()
    .then(() => { console.log('Seed completed'); process.exit(0); })
    .catch((err) => { console.error('Seed failed:', err); process.exit(1); });
}

module.exports = seed;
