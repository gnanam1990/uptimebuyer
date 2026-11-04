# UptimeBuyer Hardware and IoT Specification

Status: `SPECIFICATION_ONLY`  
Physical device, calibration, electrical safety, and field deployment: `NOT_RUN`

## 1. Purpose

Provide an evidence-grade reference telemetry path for a monitored cooler/refrigeration demo and a clean integration boundary for commercial BMS/IoT systems. The reference node is a demonstration and pilot instrument, not a certified safety controller.

## 2. Reference setup

- ESP32-class development board with unique provisioned device identity;
- digital temperature probe appropriate for the demo environment;
- optional door, current, and power-status channels;
- local status indicator that does not imply equipment safety;
- protected low-voltage power supply and enclosure appropriate to the supervised demo;
- a separate controllable heat/failure simulator; no unsafe modification of live refrigeration circuitry.

Electrical, food-safety, installation, and certification decisions require qualified personnel. The product never actuates compressors or safety interlocks in the reference scope.

## 3. Device message

```json
{
  "schemaVersion": 1,
  "deviceId": "dev_opaque",
  "bootId": "boot_random",
  "sequence": 42,
  "eventAt": "RFC3339 UTC",
  "samples": [
    {"channel": "cabinet_temp", "valueInt": 4230, "unit": "mC", "quality": "GOOD"}
  ],
  "firmware": "build-digest",
  "batteryMv": 5000
}
```

The gateway derives tenant/asset from authenticated device identity, resolves exactly one effective-dated immutable device-to-asset-revision assignment and channel/calibration revision at source event time, and stores those IDs with each sample; it never trusts asset or revision claims from the message. Rebinding appends a new assignment interval and cannot reinterpret historical samples.

## 4. Transport and identity

- MQTT over TLS; per-device credentials or certificate; least-privilege topic ACL.
- Publish topic derived from server-issued identity; retained commands disabled by default.
- Device checks broker identity; gateway rejects revoked or misassigned devices.
- Credential rotation uses a bounded overlap and audit record.
- Payload has strict size, frequency, timestamp-skew, sample-count, and unit limits.

## 5. Offline behavior

The node buffers a bounded ring of samples with original event time, boot ID, and sequence. When full, it retains defined aggregates/most recent samples and increments an explicit dropped counter. Reconnect batches are rate-limited. The gateway assigns immutable `LIVE`, `LATE`, or `BACKFILL` classification under the pinned lateness policy. Late/backfilled data may assist diagnosis but contributes zero duration to every recovery assessment, including a newly created one.

## 6. Freshness and quality

Each health projection carries a freshness status from the FR-02 set `FRESH | STALE | OFFLINE | INVALID`, kept separate from ingestion classification (`LIVE | LATE | BACKFILL`) and quality flags (`UNCALIBRATED`, `OUT_OF_RANGE`), plus source time, receipt time, the freshness threshold and a status reason (INV-11). The server tracks last event time, last receive time, immutable ingestion classification, assignment/channel/calibration revisions, expected cadence, clock skew, missing sequence ranges, and quality. A missing, overlapping or superseded binding is invalid. `LATE`, `BACKFILL`, `STALE`, `OFFLINE`, `UNCALIBRATED`, `OUT_OF_RANGE`, or revoked telemetry never contributes to the recovery stable window (INV-01, INV-11).

## 7. Calibration

Calibration records include device/channel, reference method, offset/curve, valid interval, actor, and evidence digest. Changing calibration creates a revision. Recovery assessments pin the calibration revision. The demo must document its reference comparison; it must not claim regulatory certification.

## 8. Detection and recovery rules

A rule declares:

- threshold(s) and hysteresis;
- minimum continuous breach duration;
- expected cadence and maximum gap;
- sensor quorum and fallback behavior;
- opening dedupe window;
- recovery safe range and continuous stable duration;
- post-recovery watch window;
- behavior for stale or contradictory channels.
- the tenant operating-procedure revision that supplies the response or containment deadline and the conditions that start, pause, shorten, or expire it.

Sample rule values and response deadlines are deployment configuration, not universal food-safety advice. An authorized tenant owner supplies them from a versioned operating procedure appropriate to the asset, inventory and jurisdiction. The system records the procedure revision and effective time with the incident.

An optional spoilage probability or deadline estimate is a distinct, non-authoritative derived signal. It must record model/rule version, input revisions, calibration scope, uncertainty and `as_of` time. Missing or invalid mandatory inputs produce an explicit hold. The estimate cannot extend the SOP deadline, declare food safe, or replace qualified food-safety judgment.

## 9. Simulator

The simulator uses the same signed schema and gateway path but a separate, visibly labeled device class. It supports normal, warming, missing data, duplicate/reordered sequence, clock skew, reconnect/backfill, recovery, and recurrence scenarios. Simulator evidence cannot be represented as a physical device result.

## 10. Commercial integrations

BMS/IoT adapters map vendor messages into the canonical envelope and preserve source IDs and timestamps. Each adapter documents authentication, delivery semantics, replay behavior, freshness, and authoritative fields. Vendor “alarm cleared” is not automatically equal to verified recovery.

## 11. Firmware acceptance

- deterministic build and recorded firmware digest;
- no embedded production secret in source or binary artifact;
- sequence survives transient network loss and boot ID changes on restart;
- bounded buffering and explicit dropped count;
- duplicate/reorder/skew tests pass;
- revocation and rotation tests pass;
- stale data cannot close incident;
- supervised real sensor can open and close the configured demo incident only through a policy-designated milestone, strict post-boundary `LIVE` continuous window and currently fresh tail.

Related requirements: FR-01 through FR-04, FR-14 through FR-16, FR-22; NFR-02 through NFR-06, NFR-09; INV-01, INV-09, INV-11, INV-14.

