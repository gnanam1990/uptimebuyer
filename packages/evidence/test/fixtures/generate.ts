// Regenerates the committed evidence fixtures: `node packages/evidence/test/fixtures/generate.ts`.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOM_7_CSV,
  MALICIOUS_BULLETIN_TXT,
  MANUAL_REV_B_PAGES,
  MANUAL_REV_C_PAGES,
  WORK_ORDERS_CONFLICT_CSV,
  WORK_ORDERS_CSV,
} from './content.ts';
import { buildPdf } from './pdf-builder.ts';

const here = dirname(fileURLToPath(import.meta.url));
const out = (name: string, data: Buffer | string) => writeFileSync(join(here, name), data);

out('nwr-sm-48-rev-c.pdf', buildPdf(MANUAL_REV_C_PAGES, { title: 'NWR-SM-48 Service Manual Rev C' }));
out('nwr-sm-48-rev-b.pdf', buildPdf(MANUAL_REV_B_PAGES, { title: 'NWR-SM-48 Service Manual Rev B' }));
out('nwr-2d-48-bom-7.csv', BOM_7_CSV);
out('nwr-2d-48-work-orders.csv', WORK_ORDERS_CSV);
out('nwr-2d-48-work-orders-conflict.csv', WORK_ORDERS_CONFLICT_CSV);
out('sb-2025-14.txt', MALICIOUS_BULLETIN_TXT);
