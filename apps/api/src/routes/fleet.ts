// Session, fleet health and asset telemetry (FR-19, INV-11, NFR-08). Freshness is M03's own evaluation at request time
// (getDeviceHealth): an asset is counted fresh only when every bound device is FRESH; stale, offline and invalid are
// separate counts and an asset without any bound device is NO_SIGNAL, never healthy. Telemetry samples keep their
// ingestion class, quality flags and input origin (SIMULATED_INPUT is labelled, never hidden).
import { TelemetryQuerySchema, PATH_IDS } from '@uptimebuyer/contracts/api';
import type { AssetFreshnessWire } from '@uptimebuyer/contracts/api';
import {
  getAsset,
  getDeviceHealth,
  getSessionProfile,
  listAssetDevices,
  listAssets,
  listSites,
  listTelemetrySamples,
  type AssetDevice,
  type DeviceHealthView,
  type TenantContext,
} from '@uptimebuyer/data';
import { getIncidentPins, listIncidents } from '@uptimebuyer/incidents';
import { listIncidentCommerce } from '@uptimebuyer/commerce';
import { listIncidentOrders } from '@uptimebuyer/orders';
import type { FastifyInstance } from 'fastify';
import { ctxOf, type RouteDeps } from '../app.js';
import { pathId, query } from '../http.js';

const RANK: Record<string, number> = { FRESH: 0, STALE: 1, OFFLINE: 2, INVALID: 3 };

async function devicesWithHealth(deps: RouteDeps, ctx: TenantContext, assetId: string) {
  const devices = await listAssetDevices(deps.pool, ctx, assetId);
  const out: (DeviceHealthView & { inputClass: AssetDevice['inputClass']; kinds: AssetDevice['channels'] })[] = [];
  for (const d of devices) {
    const h = await getDeviceHealth(deps.pool, ctx, d.deviceId);
    out.push({ ...h, inputClass: d.inputClass, kinds: d.channels });
  }
  return out;
}

function assetFreshness(devices: { freshness: string; statusReason: string; sourceTime: string | null }[]) {
  if (devices.length === 0)
    return { freshness: 'NO_SIGNAL' as AssetFreshnessWire, freshnessReason: 'NO_BOUND_DEVICE', sourceTime: null };
  const worst = [...devices].sort((a, b) => (RANK[b.freshness] ?? 9) - (RANK[a.freshness] ?? 9))[0]!;
  const times = devices.map((d) => d.sourceTime).filter((t): t is string => t !== null);
  return {
    freshness: worst.freshness as AssetFreshnessWire,
    freshnessReason: worst.statusReason,
    sourceTime: times.length > 0 ? times.sort()[0]! : null,
  };
}

const deviceWire = (d: Awaited<ReturnType<typeof devicesWithHealth>>[number]) => ({
  deviceId: d.deviceId,
  inputClass: d.inputClass,
  freshness: d.freshness,
  healthy: d.healthy,
  statusReason: d.statusReason,
  sourceTime: d.sourceTime,
  receiptTime: d.receiptTime,
  ageMs: d.ageMs,
  freshnessThresholdMs: d.freshnessThresholdMs,
  offlineThresholdMs: d.offlineThresholdMs,
  evaluatedAt: d.evaluatedAt,
  freshnessPolicyVersion: d.freshnessPolicyVersion,
  channels: d.channels.map((c) => ({
    channelId: c.channelId,
    freshness: c.freshness,
    statusReason: c.statusReason,
    sourceTime: c.sourceTime,
    ageMs: c.ageMs,
    lastIngestionClass: c.lastIngestionClass,
    invalidReason: c.invalidReason,
    kind: d.kinds.find((k) => k.channelId === c.channelId)?.kind ?? null,
    unit: d.kinds.find((k) => k.channelId === c.channelId)?.unit ?? null,
  })),
});

export function registerFleetRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/v1/session', async (req) => {
    const ctx = ctxOf(req);
    const profile = await getSessionProfile(deps.pool, ctx);
    const sites = await listSites(deps.pool, ctx);
    return {
      user: { userId: profile.userId, displayName: profile.displayName },
      tenant: { tenantId: profile.tenantId, name: profile.tenantName },
      grants: ctx.grants.map((g) => ({ role: g.role, siteId: g.siteId })),
      sites: sites.map((s) => ({ siteId: s.siteId, name: s.name, timezone: s.timezone })),
      correlationId: ctx.correlationId,
    };
  });

  app.get('/v1/fleet', async (req) => {
    const ctx = ctxOf(req);
    const asOf = new Date().toISOString();
    const sites = await listSites(deps.pool, ctx);
    const active = await listIncidents(deps.pool, ctx, { activeOnly: true, limit: 500 });
    let unresolved = 0;
    for (const inc of active.slice(0, 100)) {
      const orders = await listIncidentOrders(deps.pool, ctx, inc.incidentId);
      unresolved += orders.filter(
        (o) => o.economic.state === 'UNKNOWN' || o.economic.externalOutcomeState === 'UNKNOWN' || o.state === 'UNKNOWN',
      ).length;
      const commerce = await listIncidentCommerce(deps.pool, ctx, inc.incidentId);
      unresolved += commerce.authorities.filter((a) => a.session.externalOutcomeState === 'UNKNOWN').length;
    }
    const counts = {
      sites: sites.length,
      assetsFresh: 0,
      assetsStale: 0,
      assetsOffline: 0,
      assetsInvalid: 0,
      assetsNoSignal: 0,
      activeIncidents: active.length,
      criticalIncidents: active.filter((i) => i.urgency === 'CRITICAL').length,
      unresolvedExternalOutcomes: unresolved,
    };
    const outSites = [];
    for (const s of sites) {
      const assets = await listAssets(deps.pool, ctx, { siteId: s.siteId });
      const outAssets = [];
      for (const a of assets) {
        const devices = await devicesWithHealth(deps, ctx, a.assetId);
        const f = assetFreshness(devices);
        if (f.freshness === 'FRESH') counts.assetsFresh++;
        else if (f.freshness === 'STALE') counts.assetsStale++;
        else if (f.freshness === 'OFFLINE') counts.assetsOffline++;
        else if (f.freshness === 'INVALID') counts.assetsInvalid++;
        else counts.assetsNoSignal++;
        outAssets.push({
          assetId: a.assetId,
          siteId: a.siteId,
          manufacturer: a.current.manufacturer,
          model: a.current.model,
          serial: a.current.serial,
          ...f,
          inputOrigins: [...new Set(devices.map((d) => d.inputClass))],
          devices: devices.map(deviceWire),
          activeIncidentIds: active.filter((i) => i.assetId === a.assetId).map((i) => i.incidentId),
        });
      }
      outSites.push({ siteId: s.siteId, name: s.name, timezone: s.timezone, assets: outAssets });
    }
    return { asOf, sites: outSites, counts };
  });

  app.get<{ Params: { assetId: string } }>('/v1/assets/:assetId/telemetry', async (req) => {
    const ctx = ctxOf(req);
    const q = query(req, TelemetryQuerySchema);
    const assetId = pathId(req.params.assetId, PATH_IDS.assetId);
    await getAsset(deps.pool, ctx, assetId as never);
    const minutes = q.windowMinutes ? Number(q.windowMinutes) : 30;
    const asOf = new Date();
    const windowStart = new Date(asOf.getTime() - minutes * 60_000).toISOString();
    const devices = await devicesWithHealth(deps, ctx, assetId);
    const out = [];
    for (const d of devices) {
      const series = [];
      for (const ch of d.kinds) {
        const samples = await listTelemetrySamples(deps.pool, ctx, {
          channelId: ch.channelId,
          fromEventAt: windowStart,
          limit: 2_000,
        });
        series.push({
          channelId: ch.channelId,
          kind: ch.kind,
          unit: ch.unit,
          samples: samples.map((s) => ({
            sampleId: s.sampleId,
            eventAt: s.eventAt,
            receivedAt: s.receivedAt,
            valueInt: s.valueInt,
            unit: s.unit,
            qualityFlags: s.qualityFlags,
            ingestionClass: s.ingestionClass,
            inputOrigin: s.inputOrigin,
          })),
        });
      }
      out.push({ ...deviceWire(d), series });
    }
    // The threshold band comes from the rule pinned by the asset's newest active incident, when there is one.
    const active = await listIncidents(deps.pool, ctx, { assetId, activeOnly: true, limit: 1 });
    let threshold = null;
    if (active[0]) {
      const pins = await getIncidentPins(deps.pool, ctx, active[0].incidentId);
      threshold = {
        comparator: pins.rule.comparator,
        thresholdInt: pins.rule.thresholdInt,
        unit: pins.rule.channelKind === 'TEMPERATURE' ? 'MILLI_CELSIUS' : pins.rule.channelKind,
        ruleRevisionId: pins.rule.ruleRevisionId,
      };
    }
    return { assetId, windowStart, asOf: asOf.toISOString(), devices: out, threshold };
  });
}
