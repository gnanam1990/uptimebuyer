// Platform provisioning tool (M14; operator tooling, not tenant-callable): creates the global user for one OIDC subject
// and a tenant with that user as its first tenant-wide administrator (@uptimebuyer/data provisionTenant). Used by the
// clean-environment smoke run to provision a synthetic tenant for the locally issued test identity; a real deployment
// runs it once per customer under change control. Prints one JSON line with the new identifiers.
// Usage: node --import <register-dist> dist/provision.js --issuer <url> --subject <sub> --tenant-name <name>
import { provisionTenant, upsertUser } from '@uptimebuyer/data';
import pg from 'pg';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const issuer = arg('--issuer');
const subject = arg('--subject');
const tenantName = arg('--tenant-name');
const url = process.env.DATABASE_URL;
if (!issuer || !subject || !tenantName || !url || !/^postgres(ql)?:\/\//.test(url)) {
  process.stderr.write(
    'usage: provision --issuer <url> --subject <sub> --tenant-name <name> (DATABASE_URL required)\n',
  );
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: url, max: 2 });
try {
  const user = await upsertUser(pool, { issuer, externalSubject: subject, displayName: `${tenantName} administrator` });
  const { tenantId } = await provisionTenant(pool, {
    name: tenantName,
    adminUserId: user.userId,
    source: 'PROVISIONING',
  });
  console.log(JSON.stringify({ event: 'tenant.provisioned', tenantId, userId: user.userId }));
} catch (e) {
  process.stderr.write(
    `${JSON.stringify({ event: 'tenant.provision_failed', code: (e as { code?: string }).code ?? 'ERROR' })}\n`,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
