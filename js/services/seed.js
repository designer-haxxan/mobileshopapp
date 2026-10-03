// First-run defaults for a mobile shop: accessory / spare-part categories.
import * as idb from '../db/idb.js';
import { uuid, nowISO, lc } from '../core/utils.js';

export const DEFAULT_CATEGORIES = [
  'Cases & Covers', 'Tempered Glass / Protectors', 'Chargers & Adapters', 'Cables', 'Power Banks', 'Handsfree & Earbuds', 'Bluetooth Speakers',
  'Smart Watches & Bands', 'Memory Cards & USB', 'Stands & Holders', 'SIMs & Load Cards', 'Keypad Phones',
  'Spare Parts — Screens', 'Spare Parts — Batteries', 'Spare Parts — Other',
];

export async function run() {
  await idb.write(['categories', 'meta'], async (t) => {
    if (await t.get('meta', 'seed:mobile')) return;
    const have = new Set((await t.getAll('categories')).map((c) => c.nameLc));
    for (const name of DEFAULT_CATEGORIES) {
      if (have.has(lc(name))) continue;
      await t.put('categories', { id: uuid(), name, nameLc: lc(name), createdAt: nowISO(), updatedAt: nowISO() });
    }
    await t.put('meta', { key: 'seed:mobile', value: nowISO() });
  });
}
