'use strict';

/**
 * podotype ENGINE (SAAS-CLICKHOUSE BRANCH): all the actual observability
 * logic — Docker discovery/health, ClickHouse queries, alerts, retention,
 * log clustering, OTLP ingestion, state.json — with NO UI of its own
 * anymore. The React dashboard now lives in a separate, much smaller
 * process (see apps/self-hosted/web/server.js) that serves the compiled frontend and
 * proxies /api/* to this one.
 *
 * SPLIT (engine/web): this used to be one process doing both jobs. It's
 * split now because the plan is for "web" to eventually be a hosted,
 * multi-tenant routing UI while "engine" stays the thing that runs on a
 * customer's own machine next to their stack — so the boundary between
 * them needs to behave like a real network boundary (auth'd HTTP, no
 * shared filesystem/state) even while, for now, both containers still run
 * on the same host for the self-hosted product and the demo. See
 * requireEngineKey below for the auth side of that; docker-compose.yml's
 * PODOTYPE_ENGINE_API_KEY for where the shared secret comes from. Trace
 * storage is ClickHouse, reached over a separate `clickhouse` container
 * (see docker-compose.yml) — NOT the mainline OSS branch's bundled Tempo
 * child process. See "Trace storage backend" below for the swap and why
 * (licensing + this project's own lived experience with Tempo's
 * disk-management pain).
 *
 * --- This file doesn't talk to Beyla at all ---------------------------------
 * `beyla` runs as its own always-on container, wired up entirely in
 * docker-compose.yml (see that file's top comment for the full story of why
 * it's zero-config now instead of the per-service opt-in this project tried
 * first) — it watches every process on the host unconditionally and ships
 * OTLP to the `otel-collector` container, which forwards it into ClickHouse.
 * Nothing about that needs this file,
 * or the Docker API, or docker.sock: eBPF watches the kernel directly. What
 * THIS file gets from the Docker Engine API (see "Docker API client" below):
 *
 *   1. Discovery: list every container on the host directly — no traffic
 *      needed, no kernel access needed, works the same on every platform.
 *   2. Up/down: read each container's own health status (if it defines a
 *      HEALTHCHECK) or its run state, for free, for every container.
 *   3. Request metrics (opt-in per service): tail that container's logs
 *      and parse common access-log lines.
 *   4. Full traces (opt-in per service): generate an OpenTelemetry
 *      auto-instrumentation compose override for the user to apply
 *      themselves — a real, explicit, per-service config change, not
 *      something podotype can do silently from in here.
 *
 * An optional manual health check (Uptime-Kuma-style HTTP/TCP, "Active
 * health checks" below) still exists as an override for anyone who wants a
 * smarter check than "container is running" without adding a Docker
 * HEALTHCHECK to their own image.
 *
 * Toggling watched/metrics/otel is instant — it only flips local flags and
 * (for otel) hands back a file to apply; nothing here restarts anything on
 * its own.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const protobuf = require('protobufjs');
const nodemailer = require('nodemailer');

// Bumped by hand on every delivered change to server.js — the same "syncN"
// count already used to name each delivery's output folder, just made
// queryable from the running container itself (see /api/version below).
// Added after a real incident on this project: a fix was believed live in
// production for over a day because nothing distinguished "redeployed" from
// "pull/build silently no-op'd" — the only way to tell was grepping runtime
// logs for a since-deleted function's log line. That's not a repeatable way
// to verify a deploy; a version marker that changes with every real code
// change is. Bump this any time server.js changes, even a comment-only sync
// that doesn't otherwise need one, so "is my fix actually running" is always
// a one-line `curl /api/version` instead of log archaeology.
// SAAS-CLICKHOUSE BRANCH: this marker identifies the ClickHouse-backed trace
// storage swap (Tempo -> otel-collector + ClickHouse), tracked separately
// from the mainline OSS product's own BUILD_MARKER history. See "Trace
// storage backend" below for why.
const BUILD_MARKER = 'saas-clickhouse-19-account-linking';

const PORT = process.env.PORT || 8080;
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
// This container's own compose-project containers, filtered out of
// discovery — watching "podotype-app" from inside podotype is just noise.
const SELF_NAME_PREFIX = process.env.SELF_NAME_PREFIX || 'podotype-';

// ---- Trace storage backend: ClickHouse, not Tempo -------------------------
//
// The mainline product runs Tempo as a child process inside this same
// container (see git history / the OSS branch's docker-compose.yml). For
// the SaaS track that swap replaces entirely: traces now land in ClickHouse
// (Apache 2.0 — no AGPL exposure for a hosted product, unlike Tempo, see
// the project's own licensing notes). Concrete wins from this, all grounded
// in this project's own history, not theoretical: (1) no more child-process
// supervision inside `app` — one less thing that can zombie/hang this
// container's own lifecycle; (2) no more hand-rolled block-pruning
// watchdog — ClickHouse's own TTL (see ensureClickHouseSchema below)
// deletes old data on a schedule ClickHouse manages itself, exactly the
// class of "users must not have to manage another container" problem the
// OSS branch's pruneOldTempoBlocks() existed to paper over for Tempo.
//
// An earlier draft of this branch also ran a separate `otel-collector`
// container between Beyla and ClickHouse (the standard OTel Collector +
// its clickhouseexporter). That turned out to be unnecessary complexity,
// not a real requirement: Beyla's own docs confirm it can export OTLP as
// plain JSON over HTTP (`OTEL_EXPORTER_OTLP_PROTOCOL: http/json` — "Accepted
// values http/json, http/protobuf, and grpc"), and the three OTel language
// SDKs this project's opt-in path uses (Node, Python, Java) all support
// http/json too. So `app` just receives that JSON directly on
// OTLP_HTTP_PORT (see startOtlpIngestServer below) and writes it into
// ClickHouse itself — no separate collector container translating between
// them, no protobuf/gRPC parsing needed (which would have been the
// actually-hard-to-justify complexity to hand-roll). Net effect: THREE
// containers on this branch (app, beyla, clickhouse), the same count as
// the OSS branch's app+beyla+Tempo-inside-app, not four.
//
// Queried and written over ClickHouse's plain HTTP interface (default port
// 8123) — deliberately not the @clickhouse/client npm package, to keep
// this dependency-free the same way the rest of the project avoids adding
// client libraries for things a bare fetch() can do.
const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || 'http://clickhouse:8123';
const CLICKHOUSE_DATABASE = process.env.CLICKHOUSE_DATABASE || 'otel';
const CLICKHOUSE_TRACES_TABLE = process.env.CLICKHOUSE_TRACES_TABLE || 'otel_traces';
// How long ClickHouse keeps a row before its own TTL deletes it — the
// direct replacement for the OSS branch's block-retention/eager-prune
// machinery, except ClickHouse does this itself in the background.
const CLICKHOUSE_TRACE_TTL_HOURS = parseInt(process.env.CLICKHOUSE_TRACE_TTL_HOURS || '24', 10);

// Opt-in log pattern storage (per service — see "Log pattern storage"
// below for the full reasoning). A SEPARATE table with its OWN TTL/
// retention setting from traces above — deliberately not reusing
// CLICKHOUSE_TRACE_TTL_HOURS, because log volume and trace volume are
// unrelated and someone may reasonably want very different windows for
// each (e.g. long trace retention, short log-pattern retention, since the
// latter is a second copy of data Docker already keeps its own copy of —
// see mergeLogRetentionConfig's comment). Default 7 days, a much shorter
// default than traces' 24-hour default is long relative to typical trace
// volume — chosen short-side on purpose since this is genuinely additive
// storage on top of Docker's own logs, not a replacement for them.
const CLICKHOUSE_LOG_PATTERNS_TABLE = process.env.CLICKHOUSE_LOG_PATTERNS_TABLE || 'log_patterns';
const CLICKHOUSE_LOG_PATTERN_TTL_HOURS = parseInt(process.env.CLICKHOUSE_LOG_PATTERN_TTL_HOURS || '168', 10);

// ---- Long-term metrics retention -----------------------------------------
//
// Everything CPU/memory/network/disk/request-rate related, before this
// table existed, lived ONLY in containerStatsHistory/redMetricsHistory —
// in-memory Maps, capped at METRICS_HISTORY_POINTS, wiped on every engine
// restart. That's fine for "what's happening right now" (the live dashboard
// charts still read from those Maps, unchanged) but means there was
// literally no way to look back further than about an hour, or to survive a
// redeploy — the exact gap this project's own retrospective flagged: traces
// were being kept around (see CLICKHOUSE_TRACE_TTL_HOURS above) while
// metrics, the other half of "logs, metrics, traces," were not. This table
// is a periodic (see CONTAINER_METRICS_SNAPSHOT_INTERVAL_MS) low-cardinality
// snapshot of the same numbers the live charts already show — one row per
// watched service per snapshot, not a copy of every stats poll — specifically
// so a person can come back tomorrow and see what CPU/error-rate looked like
// yesterday, the same way they already can for traces.
const CLICKHOUSE_CONTAINER_METRICS_TABLE = process.env.CLICKHOUSE_CONTAINER_METRICS_TABLE || 'container_metrics';

// Since `app` creates this table itself now (see ensureClickHouseSchema),
// unlike the earlier otel-collector draft which relied on the
// clickhouseexporter's own default schema, the columns here are guaranteed
// to match what every query in this file expects — no more "verified
// against a third-party schema reproduction, not a live run" caveat that
// version of this branch had to carry.
async function queryClickHouse(sql, { database = CLICKHOUSE_DATABASE, timeoutMs } = {}) {
  const url = `${CLICKHOUSE_URL}/?database=${encodeURIComponent(database)}&default_format=JSONEachRow`;
  const res = await fetch(url, { method: 'POST', body: sql, signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ClickHouse query failed: ${res.status} ${text.slice(0, 300)}`);
  }
  const text = await res.text();
  if (!text.trim()) return [];
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

// ClickHouse String columns come back JSON-escaped as plain strings already
// (JSONEachRow does the escaping for us) — this just centralizes the
// literal-quoting needed to safely interpolate a value into SQL text.
// ClickHouse has no parameterized query support over the plain HTTP
// interface the way a driver would, so this is the actual safety boundary;
// every caller below MUST go through this rather than interpolating raw.
function sqlString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// Called once at startup (see the bottom of this file). `IF NOT EXISTS`
// makes this safe to run on every restart, not just the first one — same
// idea as any migration-on-boot pattern, just for one table with no
// migrations yet. Deliberately a MINIMAL schema: only the columns this
// file's own queries actually use (see serviceWhereClause,
// recentSpanSamples, recentTraceList, fetchTraceDetail) plus SpanAttributes
// and StatusCode (added so deriveSpanLabel and the error badges below have
// something to read) — not the full clickhouseexporter default schema
// (which also carries ScopeName, Events, Links, TraceState, etc.), which
// would still be dead weight since nothing here reads it.
async function ensureClickHouseSchema() {
  // BUG FIXED HERE (confirmed live: every service showed "no traces" with
  // the storage banner reporting `Database otel does not exist`, even
  // though this exact statement is a CREATE DATABASE IF NOT EXISTS): every
  // call through queryClickHouse puts `database=CLICKHOUSE_DATABASE` in the
  // request URL, and ClickHouse's HTTP interface switches into that
  // database BEFORE it looks at the query text — so pointing this specific
  // statement at `otel` 404s with "Database otel does not exist" before the
  // CREATE DATABASE ever runs, on every single startup, deterministically
  // (not a race with ClickHouse's own startup time — logWhenClickHouseReady
  // waiting longer would never have helped). 'default' is ClickHouse's own
  // built-in database, always present, so running this one statement
  // against it sidesteps the chicken-and-egg problem.
  await queryClickHouse(`CREATE DATABASE IF NOT EXISTS ${CLICKHOUSE_DATABASE}`, { database: 'default' });
  await queryClickHouse(`
    CREATE TABLE IF NOT EXISTS ${CLICKHOUSE_TRACES_TABLE} (
      Timestamp DateTime64(3),
      TraceId String,
      SpanId String,
      ParentSpanId String,
      ServiceName LowCardinality(String),
      SpanName LowCardinality(String),
      ResourceAttributes Map(LowCardinality(String), String),
      SpanAttributes Map(LowCardinality(String), String),
      Duration UInt64,
      Kind UInt8 DEFAULT 0,
      StatusCode UInt16 DEFAULT 0
    ) ENGINE = MergeTree()
    PARTITION BY toDate(Timestamp)
    ORDER BY (ServiceName, SpanName, Timestamp)
    TTL toDateTime(Timestamp) + INTERVAL ${CLICKHOUSE_TRACE_TTL_HOURS} HOUR
  `);
  // Added after the fact (see the big comment on serviceWhereClause below
  // for why): CREATE TABLE IF NOT EXISTS above is a no-op against a table
  // that already exists from before this column existed — an already-
  // running deployment needs this explicit ALTER to actually get the new
  // column, not just a fresh install.
  await queryClickHouse(`ALTER TABLE ${CLICKHOUSE_TRACES_TABLE} ADD COLUMN IF NOT EXISTS Kind UInt8 DEFAULT 0`);
  // Same reasoning as the Kind backfill above — spans carry their rich
  // http.route / db.statement / rpc.method / http.response.status_code
  // fields as OTLP *span* attributes (distinct from the resource-level
  // ResourceAttributes above, which only ever holds service.name and
  // similar per-process metadata). Without these two columns that data
  // was decoded off the wire and immediately dropped — see
  // ingestOtlpTraces below.
  await queryClickHouse(`ALTER TABLE ${CLICKHOUSE_TRACES_TABLE} ADD COLUMN IF NOT EXISTS SpanAttributes Map(LowCardinality(String), String)`);
  await queryClickHouse(`ALTER TABLE ${CLICKHOUSE_TRACES_TABLE} ADD COLUMN IF NOT EXISTS StatusCode UInt16 DEFAULT 0`);

  // Opt-in, per-service log pattern storage — see "Log pattern storage"
  // below. One row per (service, pattern-template, flush interval), NOT
  // one row per raw log line: storing the already-clustered shape plus a
  // count is a small fraction of the size raw lines would be, which
  // matters here specifically because this table is a deliberate SECOND
  // copy of data Docker's own log driver already has a copy of (see that
  // section's own comment for the full trade-off).
  await queryClickHouse(`
    CREATE TABLE IF NOT EXISTS ${CLICKHOUSE_LOG_PATTERNS_TABLE} (
      Timestamp DateTime64(3),
      ServiceName LowCardinality(String),
      Pattern String,
      Level LowCardinality(String),
      Count UInt32,
      SampleLine String
    ) ENGINE = MergeTree()
    PARTITION BY toDate(Timestamp)
    ORDER BY (ServiceName, Timestamp)
    TTL toDateTime(Timestamp) + INTERVAL ${CLICKHOUSE_LOG_PATTERN_TTL_HOURS} HOUR
  `);

  // Long-term metrics history — see the constant's own comment above. Same
  // retention window as traces (CLICKHOUSE_TRACE_TTL_HOURS / retention.hours)
  // on purpose: this is meant to answer "what did this service's metrics
  // look like for any trace I can still see," so tying the two to the same
  // setting means a person never ends up in the confusing state of having a
  // trace but no metrics context for it (or vice versa). See applyRetentionTtl
  // below for where changing retention.hours also updates this table's TTL.
  await queryClickHouse(`
    CREATE TABLE IF NOT EXISTS ${CLICKHOUSE_CONTAINER_METRICS_TABLE} (
      Timestamp DateTime64(3),
      ServiceName LowCardinality(String),
      CpuPercent Float32,
      MemPercent Float32,
      MemUsageBytes UInt64,
      RequestsPerSec Float32,
      ErrorRate Float32
    ) ENGINE = MergeTree()
    PARTITION BY toDate(Timestamp)
    ORDER BY (ServiceName, Timestamp)
    TTL toDateTime(Timestamp) + INTERVAL ${CLICKHOUSE_TRACE_TTL_HOURS} HOUR
  `);
}

// Changes how long ClickHouse keeps trace rows on a TABLE THAT ALREADY
// EXISTS — same "CREATE TABLE IF NOT EXISTS is a no-op against an existing
// table" gap the Kind column above has to work around, except there's no
// ADD COLUMN equivalent for a TTL clause: MODIFY TTL is the real, supported
// ClickHouse operation for changing retention on a live table without
// dropping/recreating it. Called both at startup (to re-assert whatever
// retention.hours is saved in state.json even if CREATE TABLE itself was a
// no-op this run) and from POST /api/retention/config below whenever
// someone changes it from the settings UI.
//
// IMPORTANT: this alone does NOT free disk space when shortening retention
// — ClickHouse only evicts TTL-expired rows during its own background
// merges, on its own schedule. See materializeRetentionTtl below for the
// explicit "reclaim space now" action that actually forces it.
async function applyRetentionTtl(hours) {
  await queryClickHouse(`ALTER TABLE ${CLICKHOUSE_TRACES_TABLE} MODIFY TTL toDateTime(Timestamp) + INTERVAL ${hours} HOUR`);
  // Kept in lockstep with the traces table — see CLICKHOUSE_CONTAINER_METRICS_TABLE's
  // comment for why long-term metrics history shares the trace retention
  // setting rather than having its own separate knob.
  await queryClickHouse(
    `ALTER TABLE ${CLICKHOUSE_CONTAINER_METRICS_TABLE} MODIFY TTL toDateTime(Timestamp) + INTERVAL ${hours} HOUR`
  );
}

// Forces ClickHouse to actually rewrite parts and evict now-expired rows
// immediately, rather than waiting for its own background merge schedule —
// real I/O work (reads every part, drops expired rows, writes new parts),
// so this is only ever run when someone explicitly asks for it (the
// "reclaim space now" checkbox in the retention settings UI), never as a
// side effect of just saving a new retention value.
async function materializeRetentionTtl() {
  await queryClickHouse(`ALTER TABLE ${CLICKHOUSE_TRACES_TABLE} MATERIALIZE TTL`);
}

// Real, not guessed: system.parts already carries bytes_on_disk per part,
// and this table is partitioned by day (PARTITION BY toDate(Timestamp)), so
// summing bytes_on_disk per partition gives actual historical daily volume
// straight from ClickHouse itself — the same "confirm against live data,
// don't estimate blind" bar the rest of this branch has been held to.
// Today's own partition is excluded from the average when older ones exist
// (a partial day in progress would otherwise skew a "GB/day" figure low);
// falls back to including it when it's the only partition there is (a
// brand-new deployment with less than a day of data).
async function estimateDailyTraceBytes() {
  const rows = await queryClickHouse(`
    SELECT partition, sum(bytes_on_disk) AS bytes
    FROM system.parts
    WHERE database = ${sqlString(CLICKHOUSE_DATABASE)} AND table = ${sqlString(CLICKHOUSE_TRACES_TABLE)} AND active
    GROUP BY partition
    ORDER BY partition DESC
  `);
  const todayStr = new Date().toISOString().slice(0, 10);
  const fullDays = rows.filter((r) => r.partition !== todayStr);
  const sample = fullDays.length > 0 ? fullDays : rows;
  if (sample.length === 0) return { dailyBytesEstimate: null, sampleDays: 0 };
  const totalBytes = sample.reduce((sum, r) => sum + Number(r.bytes), 0);
  return { dailyBytesEstimate: totalBytes / sample.length, sampleDays: sample.length };
}

// Same three operations as applyRetentionTtl/materializeRetentionTtl/
// estimateDailyTraceBytes above, against the log_patterns table instead of
// traces — kept as separate functions rather than a shared
// table-parameterized helper so the trace-retention path (already live,
// already carrying real user data by the time this was added) stays
// untouched by this feature.
async function applyLogPatternRetentionTtl(hours) {
  await queryClickHouse(`ALTER TABLE ${CLICKHOUSE_LOG_PATTERNS_TABLE} MODIFY TTL toDateTime(Timestamp) + INTERVAL ${hours} HOUR`);
}

async function materializeLogPatternRetentionTtl() {
  await queryClickHouse(`ALTER TABLE ${CLICKHOUSE_LOG_PATTERNS_TABLE} MATERIALIZE TTL`);
}

async function estimateDailyLogPatternBytes() {
  const rows = await queryClickHouse(`
    SELECT partition, sum(bytes_on_disk) AS bytes
    FROM system.parts
    WHERE database = ${sqlString(CLICKHOUSE_DATABASE)} AND table = ${sqlString(CLICKHOUSE_LOG_PATTERNS_TABLE)} AND active
    GROUP BY partition
    ORDER BY partition DESC
  `);
  const todayStr = new Date().toISOString().slice(0, 10);
  const fullDays = rows.filter((r) => r.partition !== todayStr);
  const sample = fullDays.length > 0 ? fullDays : rows;
  if (sample.length === 0) return { dailyBytesEstimate: null, sampleDays: 0 };
  const totalBytes = sample.reduce((sum, r) => sum + Number(r.bytes), 0);
  return { dailyBytesEstimate: totalBytes / sample.length, sampleDays: sample.length };
}

// ---- OTLP/HTTP ingestion — replaces the separate otel-collector -----------
//
// REVISED (confirmed live, with a diagnostic build, that the original plan
// here was wrong): the original version of this section assumed Beyla would
// honor OTEL_EXPORTER_OTLP_PROTOCOL=http/json and only ever send JSON, so it
// implemented JSON-only and deliberately skipped protobuf as unneeded
// complexity. Live testing proved that assumption false — Beyla 3.33.0
// sends `content-type: application/x-protobuf` regardless of BOTH
// OTEL_EXPORTER_OTLP_PROTOCOL and the more specific
// OTEL_EXPORTER_OTLP_TRACES_PROTOCOL being set to http/json (Grafana's own
// docs say both should work; this build of Beyla just doesn't honor them
// for traces — not something worth continuing to fight via env vars when
// the actual bytes on the wire are right here to look at instead).
//
// Rather than keep chasing Beyla's protocol negotiation across versions,
// this now accepts BOTH encodings and picks by Content-Type — decoupling
// `app` from whatever Beyla (or any future OTel-SDK opt-in traffic) decides
// to send. The protobuf schema below is the minimal subset of OTLP's own
// trace.proto/common.proto actually needed here (verified against a real
// captured Beyla payload's first bytes — 0x0a is the field-1/length-delimited
// tag for `resource_spans`, matching this schema exactly — and round-tripped
// through an encode→decode test before shipping this) — not hand-rolled
// wire-format parsing, which would be easy to get subtly wrong for a binary
// format; protobufjs does the actual decoding.
const protoSchema = `
syntax = "proto3";
package opentelemetry.proto.collector.trace.v1;

message ExportTraceServiceRequest {
  repeated ResourceSpans resource_spans = 1;
}
message ResourceSpans {
  Resource resource = 1;
  repeated ScopeSpans scope_spans = 2;
}
message Resource {
  repeated KeyValue attributes = 1;
}
message ScopeSpans {
  repeated Span spans = 2;
}
message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  string trace_state = 3;
  bytes parent_span_id = 4;
  string name = 5;
  int32 kind = 6;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9;
}
message KeyValue {
  string key = 1;
  AnyValue value = 2;
}
message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    ArrayValue array_value = 5;
    KeyValueList kvlist_value = 6;
    bytes bytes_value = 7;
  }
}
message ArrayValue {
  repeated AnyValue values = 1;
}
message KeyValueList {
  repeated KeyValue values = 1;
}
`;
const ExportTraceServiceRequestType = protobuf
  .parse(protoSchema)
  .root.lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest');

// protobufjs decodes trace_id/span_id/parent_span_id as Buffers and uses
// snake_case-to-camelCase field names automatically — this just converts
// the byte fields to the same lowercase-hex strings the JSON path already
// produces (OTLP JSON's own encoding convention for these specific fields,
// unlike other bytes fields which use base64), so ingestOtlpTraces below
// can treat both encodings identically without knowing which one arrived.
function decodeOtlpProtobufTraces(raw) {
  const decoded = ExportTraceServiceRequestType.decode(raw);
  const obj = ExportTraceServiceRequestType.toObject(decoded, { longs: String, bytes: Buffer, defaults: true });
  for (const rs of obj.resourceSpans || []) {
    for (const ss of rs.scopeSpans || []) {
      for (const span of ss.spans || []) {
        span.traceId = span.traceId ? span.traceId.toString('hex') : '';
        span.spanId = span.spanId ? span.spanId.toString('hex') : '';
        span.parentSpanId = span.parentSpanId ? span.parentSpanId.toString('hex') : '';
      }
    }
  }
  return obj;
}

const OTLP_HTTP_PORT = parseInt(process.env.OTLP_HTTP_PORT || '4318', 10);

// OTLP JSON attributes are [{key, value: {stringValue|intValue|...}}] —
// this pulls one value out by key. (Same shape Tempo's old /api/traces/<id>
// JSON used, which the OSS branch's now-removed otlpAttr() also parsed —
// same wire format, different direction: reading it there, writing it
// here.)
function otlpJsonAttr(attributes, key) {
  const found = (attributes || []).find((a) => a.key === key);
  if (!found || !found.value) return null;
  const v = found.value;
  return v.stringValue ?? v.intValue ?? v.boolValue ?? v.doubleValue ?? null;
}

// The full attribute list as a plain {key: stringValue} object, for
// ClickHouse's ResourceAttributes Map column — JSONEachRow accepts a plain
// JSON object for a Map(String, String) column directly.
function otlpAttributesToMap(attributes) {
  const map = {};
  for (const a of attributes || []) {
    if (!a.value) continue;
    const v = a.value;
    map[a.key] = String(v.stringValue ?? v.intValue ?? v.boolValue ?? v.doubleValue ?? '');
  }
  return map;
}

// HTTP status code off the SPAN's own attributes (Beyla/most SDKs set one
// of these two keys, depending on semconv version) — separate from
// otlpAttributesToMap above, which only ever reads RESOURCE attributes.
// Same helper, same semantics as apps/hosted/agent/server.js's otlpSpanStatusCode
// (hosted build) — kept identical on purpose so StatusCode means the same
// thing in both otel_traces tables: a real HTTP status (404, 500, …), not
// OTLP's separate coarse Status.code enum. 0 when absent, same "no data"
// convention Kind already uses here.
function otlpSpanStatusCode(span) {
  const v = otlpJsonAttr(span.attributes, 'http.status_code') ?? otlpJsonAttr(span.attributes, 'http.response.status_code');
  const n = typeof v === 'string' ? parseInt(v, 10) : v;
  return Number.isFinite(n) ? n : 0;
}

// ClickHouse's JSONEachRow input for a DateTime64 column expects
// "YYYY-MM-DD HH:MM:SS.sss" text, not a raw unix-nanoseconds integer —
// this converts the nanosecond timestamps OTLP always uses into that
// shape. Millisecond precision (not full nanosecond) is a deliberate
// simplification: nothing in this UI displays sub-millisecond timing, so
// there's no reason to carry the extra 6 digits of precision through
// storage and every query.
function otlpNanoToClickHouseDateTime64(unixNano) {
  const ms = Number(BigInt(unixNano || 0) / 1000000n);
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

// Flattens one ExportTraceServiceRequest (resourceSpans -> scopeSpans ->
// spans) into ClickHouse rows and inserts them in a single batch. Mirrors
// the shape fetchTraceDetail below reads back out, just in the opposite
// direction — writing spans instead of reading them.
async function ingestOtlpTraces(exportRequest) {
  const rows = [];
  for (const rs of exportRequest.resourceSpans || []) {
    const resourceAttrs = rs.resource && rs.resource.attributes;
    const serviceName = otlpJsonAttr(resourceAttrs, 'service.name') || 'unknown-service';
    const resourceAttributes = otlpAttributesToMap(resourceAttrs);
    for (const ss of rs.scopeSpans || []) {
      for (const span of ss.spans || []) {
        const startNs = BigInt(span.startTimeUnixNano || 0);
        const endNs = BigInt(span.endTimeUnixNano || 0);
        rows.push({
          Timestamp: otlpNanoToClickHouseDateTime64(span.startTimeUnixNano),
          TraceId: span.traceId || '',
          SpanId: span.spanId || '',
          ParentSpanId: span.parentSpanId || '',
          ServiceName: serviceName,
          SpanName: span.name || '',
          ResourceAttributes: resourceAttributes,
          // Per-span semantic-convention attributes — http.route,
          // http.response.status_code, db.statement, db.system, rpc.method,
          // rpc.system, url.path, server.address, etc. Beyla already sends
          // all of this on the span itself (not the resource), it just sat
          // decoded-and-discarded here before: otlpAttributesToMap was
          // already written for ResourceAttributes above and works
          // identically for any KeyValue list, span or resource.
          SpanAttributes: otlpAttributesToMap(span.attributes),
          Duration: endNs > startNs ? Number(endNs - startNs) : 0, // nanoseconds
          // OTLP's own SpanKind enum (0=UNSPECIFIED, 1=INTERNAL, 2=SERVER,
          // 3=CLIENT, 4=PRODUCER, 5=CONSUMER) — captured now specifically to
          // fix serviceWhereClause's ParentSpanId='' bug (see its comment):
          // was never stored before because the schema didn't carry it.
          Kind: typeof span.kind === 'number' ? span.kind : parseInt(span.kind, 10) || 0,
          // OTLP's Status.code (0=UNSET, 1=OK, 2=ERROR) — UNSET is the
          // overwhelming majority case (most instrumentation, Beyla
          // included, only sets this explicitly on failure), so treating
          // "no status block at all" the same as UNSET (0) is correct, not
          // a lossy default.
          StatusCode: otlpSpanStatusCode(span),
        });
      }
    }
  }
  if (rows.length === 0) return;

  // ClickHouse's HTTP insert shape: SQL goes in the `query` parameter, raw
  // newline-delimited JSON rows go in the body — the mirror image of
  // queryClickHouse's SELECT shape (SQL in the body, JSONEachRow out).
  const insertSql = `INSERT INTO ${CLICKHOUSE_TRACES_TABLE} FORMAT JSONEachRow`;
  const url = `${CLICKHOUSE_URL}/?database=${encodeURIComponent(CLICKHOUSE_DATABASE)}&query=${encodeURIComponent(insertSql)}`;
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  const res = await fetch(url, { method: 'POST', body });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ClickHouse insert failed: ${res.status} ${text.slice(0, 300)}`);
  }
}

// Plain http.Server (not app.listen — this is a separate port, see
// OTLP_HTTP_PORT) implementing exactly one route. Anything else 404s;
// there is no other OTLP signal (metrics/logs) this project ingests this
// way — Beyla's RED metrics come from its own Prometheus endpoint instead
// (see pollBeylaRedMetrics), not OTLP.
function startOtlpIngestServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/traces') {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        // Two real, confirmed-live encodings to handle, in the order they
        // were actually discovered debugging this:
        //  1) gzip Content-Encoding — the OTel Go SDK compresses by default
        //     regardless of payload encoding; any exporter could send this.
        //  2) Content-Type deciding JSON vs protobuf — Beyla sends protobuf
        //     no matter what OTEL_EXPORTER_OTLP_(TRACES_)PROTOCOL says (see
        //     the big comment above ExportTraceServiceRequestType), so this
        //     branches on the actual bytes' declared type rather than
        //     trusting Beyla's config to match what it really sends.
        const raw = Buffer.concat(chunks);
        const encoding = (req.headers['content-encoding'] || '').toLowerCase();
        const body = encoding === 'gzip' ? zlib.gunzipSync(raw) : raw;
        const contentType = (req.headers['content-type'] || '').toLowerCase();
        const exportRequest = contentType.includes('protobuf')
          ? decodeOtlpProtobufTraces(body)
          : JSON.parse(body.toString('utf8'));
        await ingestOtlpTraces(exportRequest);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      } catch (err) {
        // Logged, not thrown further — an ingest failure (ClickHouse
        // briefly unreachable, a malformed batch, an encoding this server
        // still doesn't recognize) should drop that one batch, not crash
        // the whole container the way an uncaught exception in an
        // http.Server request handler otherwise would.
        console.warn(`[otlp-ingest] failed to process an incoming batch: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
      }
    });
    req.on('error', (err) => console.warn(`[otlp-ingest] request stream error: ${err.message}`));
  });
  server.listen(OTLP_HTTP_PORT, () => {
    console.log(`[app] OTLP/HTTP (JSON) trace ingestion listening on :${OTLP_HTTP_PORT}`);
  });
  return server;
}

// A service counts as having "recent" traffic if we've seen a span from it
// in this many seconds. Only relevant for services that have opted into
// OTel tracing (see "OpenTelemetry opt-in" below) — everyone else's
// up/down comes from Docker directly, not from this.
const STALE_AFTER_SECONDS = parseInt(process.env.STALE_AFTER_SECONDS || '60', 10);
// "Slow" if the p95-ish of recent span durations exceeds this many ms.
const SLOW_THRESHOLD_MS = parseInt(process.env.SLOW_THRESHOLD_MS || '500', 10);
// How far back to look when sampling recent traces per service.
const LOOKBACK_SECONDS = parseInt(process.env.LOOKBACK_SECONDS || '300', 10);
// How often to re-run each service's active health check, and how long to
// wait for one before calling it a failure. Kept short by default — this is
// meant to feel like Uptime Kuma, not a slow batch job.
const CHECK_INTERVAL_SECONDS = parseInt(process.env.CHECK_INTERVAL_SECONDS || '30', 10);
const CHECK_TIMEOUT_SECONDS = parseInt(process.env.CHECK_TIMEOUT_SECONDS || '5', 10);
// How many recent log lines to sample per service when log-based request
// metrics are enabled. A sample, not a full tail — this runs on every
// /api/status poll, so it stays small on purpose (see "Log-based request
// metrics" below for why this is a live read, not a background timer).
const LOG_METRICS_SAMPLE_LINES = parseInt(process.env.LOG_METRICS_SAMPLE_LINES || '200', 10);

// ---- Shutdown ---------------------------------------------------------
//
// No child process to supervise anymore — this is the direct payoff of
// moving trace storage out to its own otel-collector + ClickHouse
// containers (see "Trace storage backend" above): `app`'s shutdown is now
// just "stop our own background checks and exit," the same shape every
// other stateless web server has. The mainline OSS branch's shutdown() is
// meaningfully more involved than this because it also has to supervise
// Tempo as a child process; that whole class of complexity (SIGTERM ->
// wait -> SIGKILL fallback, "tempo exited unexpectedly" fatal handling)
// simply has nothing to attach to here.
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[app] received ${signal}, shutting down...`);
  for (const name of activeChecks.keys()) stopCheck(name);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Best-effort log line once ClickHouse answers its own /ping — purely
// informational, nothing here blocks the UI on it. Existing route error
// handling already tolerates ClickHouse being briefly unavailable at
// startup (e.g. its healthcheck in docker-compose.yml hasn't passed yet).
async function logWhenClickHouseReady() {
  for (let i = 0; i < 30 && !shuttingDown; i++) {
    try {
      const res = await fetch(`${CLICKHOUSE_URL}/ping`);
      if (res.ok) {
        console.log('[app] clickhouse is ready');
        return;
      }
    } catch {
      // not up yet, keep polling
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ---- Storage watchdog --------------------------------------------------
//
// The OSS/Tempo branch's watchdog exists because Tempo's local backend has
// no disk-size-based retention of its own, so a self-hosted box could
// quietly fill up with no automatic recovery — that whole file's worth of
// code (listBlockDirsOldestFirst / pruneOldTempoBlocks / the
// warning-vs-critical eager-prune gating) was working around a gap in
// Tempo specifically. ClickHouse doesn't have that gap: the `ttl: 24h`
// (or whatever CLICKHOUSE_TRACE_TTL_HOURS is set to) in
// clickhouse/otel-collector-config.yaml is a real, native ClickHouse table
// TTL — ClickHouse deletes expired rows itself, on its own schedule, as a
// normal part of background merges. There is nothing here for `app` to
// eagerly prune, because there's no "Tempo might not get to it before the
// disk fills" gap to close.
//
// What's left for `app` to do is just report disk status, the same
// signal shape (/api/status's `storage` field, same 'ok'/'warning'/
// 'critical' bands) the frontend's AttentionBanner already knows how to
// render — but the DISK in question is now ClickHouse's own volume, not a
// path inside this container, so this asks ClickHouse itself via
// `system.disks` rather than statfs-ing a local mount. `lastAutoPrune`
// stays in the shape for frontend compatibility but is always null here —
// there's no eager prune to report, only ClickHouse's own background TTL
// sweep, which doesn't emit anything this container could observe.
const STORAGE_WARNING_PERCENT = parseInt(process.env.STORAGE_WARNING_PERCENT || '85', 10);
const STORAGE_CRITICAL_PERCENT = parseInt(process.env.STORAGE_CRITICAL_PERCENT || '95', 10);
const STORAGE_CHECK_INTERVAL_MS = 30000;

let storageStatus = {
  checkedAt: null,
  path: 'clickhouse:/var/lib/clickhouse',
  usedPercent: null,
  freeBytes: null,
  totalBytes: null,
  status: 'unknown', // 'ok' | 'warning' | 'critical' | 'unknown'
  error: null,
  lastAutoPrune: null, // always null on this branch — see comment above
};

async function checkStorage() {
  const prevStatus = storageStatus.status;
  try {
    // system.disks is a ClickHouse system table, one row per configured
    // disk — 'default' is the disk ClickHouse itself is installed onto
    // unless the server config defines extra storage policies, which this
    // project's otel-collector-config.yaml/clickhouse setup does not.
    const rows = await queryClickHouse(
      `SELECT free_space, total_space FROM system.disks WHERE name = 'default'`
    );
    if (rows.length === 0) throw new Error("no 'default' disk reported by system.disks");
    const freeBytes = Number(rows[0].free_space);
    const totalBytes = Number(rows[0].total_space);
    const usedPercent = totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 1000) / 10 : null;

    let status = 'ok';
    if (usedPercent !== null) {
      if (usedPercent >= STORAGE_CRITICAL_PERCENT) status = 'critical';
      else if (usedPercent >= STORAGE_WARNING_PERCENT) status = 'warning';
    }

    storageStatus = { ...storageStatus, checkedAt: new Date().toISOString(), usedPercent, freeBytes, totalBytes, status, error: null };

    if (status !== 'ok' && status !== prevStatus) {
      const freeMb = Math.round(freeBytes / 1e6);
      console.warn(
        `[storage] ClickHouse's disk is ${usedPercent}% full (${freeMb}MB free) — status: ${status}. ` +
          'No action needed from this container — ClickHouse ages out rows past its own TTL automatically; ' +
          'if this persists, the disk itself is too small for current trace volume (see CLICKHOUSE_TRACE_TTL_HOURS to retain less).'
      );
    } else if (status === 'ok' && prevStatus !== 'ok' && prevStatus !== 'unknown') {
      console.log(`[storage] ClickHouse's disk back down to ${usedPercent}% used — status: ok.`);
    }
  } catch (err) {
    storageStatus = { ...storageStatus, checkedAt: new Date().toISOString(), status: 'unknown', error: err.message };
    console.warn(`[storage] could not check ClickHouse's free space: ${err.message}`);
  }
}

// ---- Docker API client ------------------------------------------------
//
// Talks to the Docker Engine API over the socket mounted at DOCKER_SOCKET
// (see docker-compose.yml). Deliberately implemented with Node's built-in
// `http` module (which supports `socketPath` natively) rather than adding
// "dockerode" or another client library — one fewer dependency to go
// stale or carry its own bugs, for something this small. No API version
// prefix is sent (e.g. plain "/containers/json", not "/v1.45/..."): the
// Docker Engine API keeps this small surface stable across versions, and
// omitting the prefix lets the daemon pick its own default rather than us
// having to track a version number here.
function dockerRequest(method, apiPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: DOCKER_SOCKET, path: apiPath, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(buffer);
        } else {
          reject(new Error(`Docker API ${method} ${apiPath} -> ${res.statusCode}: ${buffer.toString('utf8').slice(0, 300)}`));
        }
      });
    });
    req.on('error', (err) => {
      // ENOENT here almost always means the socket isn't mounted, which is
      // a much more common misconfiguration than "Docker itself is down" —
      // worth calling out by name instead of surfacing a bare ENOENT.
      if (err.code === 'ENOENT') {
        reject(new Error(`Docker socket not found at ${DOCKER_SOCKET} — check that docker-compose.yml mounts it under app's volumes`));
      } else {
        reject(err);
      }
    });
    req.end();
  });
}

async function dockerJSON(apiPath) {
  const buffer = await dockerRequest('GET', apiPath);
  return buffer.length ? JSON.parse(buffer.toString('utf8')) : null;
}

// The ONE write this engine makes against the Docker socket — every other
// use of dockerRequest/dockerJSON above is a GET (discovery, inspect,
// logs). PHP's Code Tracing setup (see generateOtelOverride below) needs a
// real repo:tag it can hand to Compose — a bare image ID, even truncated,
// isn't something Compose's "image:" field can reliably resolve without
// trying (and failing) a registry pull first; see generateOtelOverride's
// own comment for the two different ways that already failed. Tagging the
// already-local image under a predictable podotype-owned name is a tiny,
// non-destructive operation (it ADDS a tag, never removes or rebuilds
// anything) and is the one Docker officially supports for "make this
// local image resolvable by a stable name" — same POST /images/{id}/tag
// endpoint `docker tag` itself calls.
async function dockerTagImage(sourceId, repo, tag) {
  const bareId = sourceId.startsWith('sha256:') ? sourceId.slice('sha256:'.length) : sourceId;
  const path = `/images/${bareId}/tag?repo=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`;
  await dockerRequest('POST', path);
}

// Docker's container-logs endpoint multiplexes stdout/stderr into 8-byte-
// header-prefixed frames UNLESS the container was created with a TTY, in
// which case it's plain bytes. Demultiplex when we can tell it's framed;
// fall back to treating the whole response as plain text otherwise — a
// rough parse beats silently reporting zero log lines forever.
function demuxDockerLogs(buffer) {
  let text = '';
  let offset = 0;
  let sawFrame = false;
  while (offset + 8 <= buffer.length) {
    const streamType = buffer.readUInt8(offset);
    const size = buffer.readUInt32BE(offset + 4);
    if (streamType > 2 || offset + 8 + size > buffer.length) break; // doesn't look like a real frame header
    text += buffer.slice(offset + 8, offset + 8 + size).toString('utf8');
    offset += 8 + size;
    sawFrame = true;
  }
  if (!sawFrame) text = buffer.toString('utf8');
  return text.split('\n').filter((line) => line.length > 0);
}

// Full inspect for ONE container — unlike listContainers (the cheap bulk
// endpoint used for every poll), this returns Config.Cmd/Entrypoint/Env,
// which is what language-guessing below needs. Deliberately not folded into
// listContainers: that runs on every /api/status poll, and an extra
// per-container round trip for data almost nothing needs would slow that
// down for no benefit. This is only called on demand, when someone's about
// to set up tracing for one specific service.
async function inspectContainer(id) {
  return dockerJSON(`/containers/${encodeURIComponent(id)}/json`);
}

// Every container on the host, Docker's own view — this is the whole of
// "discovery" now. No traffic required, no waiting: a container shows up
// here the moment it exists, whether or not anything has ever talked to it.
async function listContainers() {
  let raw;
  try {
    raw = await dockerJSON('/containers/json?all=true');
  } catch (err) {
    throw new Error(`Docker container list failed: ${describeFetchError(err)}`);
  }
  return (raw || [])
    .map((c) => ({
      id: c.Id,
      name: ((c.Names && c.Names[0]) || '').replace(/^\//, ''),
      image: c.Image,
      state: c.State, // "running" | "exited" | "restarting" | "paused" | "created" | "dead"
      status: c.Status, // human string, e.g. "Up 2 hours (healthy)"
      // The actual `services:` key in whatever compose file created this
      // container — Docker Compose sets this label automatically, and it's
      // frequently DIFFERENT from the container's display name whenever a
      // compose file sets an explicit `container_name:` (very common). Only
      // the compose service key is valid to merge an override against —
      // see generateOtelOverride below for why this matters.
      composeService: (c.Labels && c.Labels['com.docker.compose.service']) || null,
      // Every IP address this container has across every Docker network
      // it's attached to (usually just one — the default `podotype`
      // bridge network everything in docker-compose.yml shares) — NOT
      // present on every Docker API response shape, but IS present on
      // this one (GET /containers/json, what this function already
      // calls), which returns NetworkSettings.Networks inline without a
      // second per-container inspect call. See fetchNetworkFlowEdges
      // below for what this is for: resolving Beyla's network-flow
      // src_address/dst_address labels (raw IPs) back to a container
      // name, the same "resolve from the outside" approach
      // resolveBeylaServiceName already uses for HTTP service names.
      ipAddresses: Object.values((c.NetworkSettings && c.NetworkSettings.Networks) || {})
        .map((n) => n && n.IPAddress)
        .filter(Boolean),
    }))
    .filter((c) => c.name && !c.name.startsWith(SELF_NAME_PREFIX));
}

// Turn Docker's own view of a container into an up/down verdict. Precedence:
// a container's own HEALTHCHECK (if it defines one — Docker puts the result
// right in the `Status` string) beats a bare run-state guess, because a
// container can be "running" while its actual health check inside is
// failing (crash-looping request handler, DB connection dead, etc).
function dockerHealthSignal(container) {
  if (!container) return { up: null, source: 'not-found' };
  const m = /\((healthy|unhealthy|health: starting)\)/.exec(container.status || '');
  if (m) {
    if (m[1] === 'healthy') return { up: true, source: 'docker-health' };
    if (m[1] === 'unhealthy') return { up: false, source: 'docker-health' };
    return { up: null, source: 'docker-health-starting' }; // "health: starting" — first check hasn't run yet
  }
  // No HEALTHCHECK defined on this container — fall back to its run state.
  if (container.state === 'running') return { up: true, source: 'docker-state' };
  if (container.state === 'exited' || container.state === 'dead') return { up: false, source: 'docker-state' };
  return { up: null, source: 'docker-state' }; // restarting/paused/created — genuinely ambiguous, don't guess
}

// ---- Log-based request metrics (opt-in per service) ------------------------
//
// Zero-code, like discovery: reads a container's own stdout/stderr via the
// Docker API (same mechanism as `docker logs`) and looks for lines that
// match a standard web-server access-log format. Only the common/combined
// format is recognized in this first version (nginx and Apache both default
// to it) — anything else is honestly reported as "not recognized" rather
// than silently showing zero, since a service's own custom log format is
// impossible to guess reliably. This deliberately runs live on each
// /api/status poll rather than as a background timer: it's a cheap local
// read (no network, no kernel access), and keeping it request-scoped means
// there's no extra state to get stale or leak if a service is un-watched.
const ACCESS_LOG_RE = /"[A-Z]+ \S+ HTTP\/[\d.]+"\s+(\d{3})\s+(\d+|-)/;

function parseAccessLogMetrics(lines) {
  let matched = 0;
  let errors = 0;
  for (const line of lines) {
    const m = ACCESS_LOG_RE.exec(line);
    if (!m) continue;
    matched++;
    if (parseInt(m[1], 10) >= 500) errors++;
  }
  return {
    sampledLines: lines.length,
    matchedLines: matched,
    errorCount: errors,
    errorRate: matched > 0 ? errors / matched : null,
    recognized: matched > 0,
  };
}

async function logMetricsForContainer(containerId) {
  try {
    const buffer = await dockerRequest(
      'GET',
      `/containers/${containerId}/logs?stdout=true&stderr=true&tail=${LOG_METRICS_SAMPLE_LINES}`
    );
    const lines = demuxDockerLogs(buffer);
    return { ...parseAccessLogMetrics(lines), error: null };
  } catch (err) {
    return {
      sampledLines: 0,
      matchedLines: 0,
      errorCount: null,
      errorRate: null,
      recognized: false,
      error: describeFetchError(err),
    };
  }
}

// ---- Container health: CPU/memory from Docker's own stats API -------------
//
// A distinct thing from everything above: RED metrics (rate/errors/
// duration) answer "are this service's REQUESTS healthy" — this answers
// "is the CONTAINER itself healthy" (about to get OOM-killed, pegging a
// CPU). Neither Beyla nor Tempo has any of this — it's pure Docker Engine
// API, the same data `docker stats` itself shows, read straight off
// DOCKER_SOCKET like everything else here. No new container, no new
// dependency.
//
// Deliberately polled in the background on its own timer rather than read
// live inside /api/status: Docker's non-streaming stats endpoint
// (?stream=false) samples CPU usage twice about a second apart before it
// replies, so calling it inline on every dashboard poll would make
// /api/status itself slow to answer. Same "poll in the background, serve
// the cached snapshot" shape as the storage watchdog and RED metrics above.
const CONTAINER_STATS_POLL_INTERVAL_MS = 20000;
// Much slower than the 20s in-memory stats poll above on purpose: a snapshot
// every 60s (60 rows/service/hour, ~1440/day) is plenty of resolution for
// looking back at "what did yesterday afternoon look like," while keeping
// this genuinely-second-copy-of-data table's write volume and disk footprint
// small relative to the trace data ClickHouse is already storing.
const CONTAINER_METRICS_SNAPSHOT_INTERVAL_MS = 60000;
// Env vars seed the FIRST-RUN default only — once alertConfig.thresholds
// exists in state.json (see defaultAlertConfig/loadState below), the value
// saved there via the Alerts settings UI wins from then on, same as every
// other per-service setting this file already persists to state.json rather
// than re-reading from the environment on every use.
const MEM_WARNING_PERCENT_DEFAULT = parseInt(process.env.MEM_WARNING_PERCENT || '85', 10);
const MEM_CRITICAL_PERCENT_DEFAULT = parseInt(process.env.MEM_CRITICAL_PERCENT || '95', 10);
// How many samples of history to keep per watched container/service, across
// CPU, memory, network, disk and request-rate charts alike — one shared
// constant so "how far back can I see" means the same thing everywhere
// rather than a different window per chart. At the default 20s container-
// stats cadence, 180 points is an hour; RED-metrics history (polled on its
// own faster 15s cycle, see RED_METRICS_POLL_INTERVAL_MS) ends up covering
// somewhat less than that at the same point count, which is fine — request
// rate is the one signal here that's actually worth seeing at finer
// resolution anyway.
const METRICS_HISTORY_POINTS = parseInt(process.env.METRICS_HISTORY_POINTS || '180', 10);

// containerId -> { cpuPercent, memUsageBytes, memLimitBytes, memPercent,
// status, netRxRateBps, netTxRateBps, blkReadRateBps, blkWriteRateBps,
// restartCount, uptimeSeconds, checkedAt, error }. memLimitBytes/memPercent/
// status stay null when the container has no configured memory limit — see
// the configuredLimit comment below for why that's deliberate, not a bug.
// The four *RateBps fields stay null on a container's first sample (a rate
// needs two points to diff against — see containerIoPrev below) and restart
// count/uptime stay null only if Docker's inspect call itself failed.
let containerHealthCache = new Map();

// containerId -> { netRxBytes, netTxBytes, blkReadBytes, blkWriteBytes, atMs }
// — the previous poll's CUMULATIVE counters, kept only to diff against the
// next poll. Docker's stats endpoint reports net/disk I/O as running totals
// since the container started, not as a rate — unlike CPU, where
// cpu_stats/precpu_stats already come paired in a single response. Same
// idea as redMetricsPrevSnapshot below, just for Docker stats instead of
// Beyla's Prometheus counters.
let containerIoPrev = new Map();

// containerId -> bounded array of { t, cpuPercent, memPercent, memUsageBytes,
// netRxRateBps, netTxRateBps, blkReadRateBps, blkWriteRateBps }, oldest
// first, capped at METRICS_HISTORY_POINTS — what GET
// /api/services/:name/metrics-history actually charts. Kept separate from
// containerHealthCache (which is just "the latest reading", read on every
// /api/status poll) so that hot path stays a cheap Map lookup instead of
// growing an array on every request.
let containerStatsHistory = new Map();

// containerName -> the image ID (sha256, from Docker inspect's `.Image`
// field — NOT the image tag, which a `:latest`-style tag reuses across
// deploys and so can't detect a change) last seen for that name. Used by
// pollContainerHealth to notice "this watched service's container was
// recreated from a different image" and record it as a deploy marker (see
// recordDeployMarkers below) — the single most common real-world explanation
// for "why did errors/latency suddenly change," and one this project can
// detect for free since inspectContainer() is already being called here on
// every poll anyway.
let lastKnownContainerImage = new Map();

// Bounded, persisted (state.json, same as alertConfig/retention) log of
// detected deploys — { service, at, fromImage, toImage }, newest first,
// capped at DEPLOY_MARKER_LIMIT. Kept separate from alertHistory (which is
// in-memory only and about alert fire/resolve events, not deploys) since a
// deploy marker needs to survive an engine restart to be useful — the whole
// point is lining up "when did this last change" against metrics/traces
// that are also being looked at well after the fact.
const DEPLOY_MARKER_LIMIT = 500;

function pushBoundedHistory(map, key, point) {
  const arr = map.get(key) || [];
  arr.push(point);
  if (arr.length > METRICS_HISTORY_POINTS) arr.shift();
  map.set(key, arr);
}

async function fetchContainerStatsOnce(containerId) {
  const buffer = await dockerRequest('GET', `/containers/${encodeURIComponent(containerId)}/stats?stream=false`);
  return JSON.parse(buffer.toString('utf8'));
}

// Same formula `docker stats`/the Docker CLI itself uses: CPU time this
// container burned during the sample window, as a percentage of one CPU's
// worth of that same window, scaled by however many CPUs are online (so
// "200%" means fully saturating 2 cores, not "over 100% and something's
// wrong").
function computeCpuPercent(stats) {
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const sysDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
  const onlineCpus =
    stats.cpu_stats.online_cpus ||
    (stats.cpu_stats.cpu_usage.percpu_usage ? stats.cpu_stats.cpu_usage.percpu_usage.length : 1);
  if (sysDelta > 0 && cpuDelta > 0) return (cpuDelta / sysDelta) * onlineCpus * 100;
  return 0;
}

// Subtracts page cache from the raw usage figure, same as `docker stats`
// does — cgroup v1 exposes it as memory_stats.stats.cache, v2 as
// inactive_file. Page cache Linux is holding "for free" (reclaimed
// instantly under real memory pressure) isn't what anyone means by "this
// container is using memory" — leaving it in would make an app that reads
// a lot of files look like it's about to OOM when it isn't.
function computeMemUsage(stats) {
  const memStats = stats.memory_stats || {};
  const raw = memStats.usage || 0;
  const cache = (memStats.stats && (memStats.stats.cache ?? memStats.stats.inactive_file)) || 0;
  return Math.max(0, raw - cache);
}

// stats.networks is keyed by interface name (eth0, eth1, ...) — summed
// across every interface, same as `docker stats`'s own NET I/O column,
// since a container with more than one network attached (this project's own
// `podotype` network plus anything else compose wires up) would otherwise
// only show whichever interface happened to be reported first.
function computeNetIoTotals(stats) {
  let rx = 0;
  let tx = 0;
  for (const iface of Object.values(stats.networks || {})) {
    rx += iface.rx_bytes || 0;
    tx += iface.tx_bytes || 0;
  }
  return { rxBytes: rx, txBytes: tx };
}

// blkio_stats.io_service_bytes_recursive is a flat list of
// { major, minor, op, value } — one pair of entries (Read/Write) per block
// device the container touched, so this sums across devices the same way
// computeNetIoTotals sums across interfaces. cgroup v1 capitalizes op names
// ("Read"/"Write"); cgroup v2 reports them lowercase — checked
// case-insensitively so this doesn't silently report zero on whichever
// cgroup version this host happens to use.
function computeBlkIoTotals(stats) {
  const entries = (stats.blkio_stats && stats.blkio_stats.io_service_bytes_recursive) || [];
  let read = 0;
  let write = 0;
  for (const e of entries) {
    const op = (e.op || '').toLowerCase();
    if (op === 'read') read += e.value || 0;
    else if (op === 'write') write += e.value || 0;
  }
  return { readBytes: read, writeBytes: write };
}

async function pollContainerHealth() {
  const state = loadState();
  const watchedNames = new Set(Object.entries(state.services).filter(([, e]) => e.watched).map(([n]) => n));
  if (watchedNames.size === 0) return;
  // Read live from state.alertConfig (settable via the Alerts settings UI —
  // see /api/alerts/config) rather than the env-var defaults directly, so
  // changing the memory threshold in the UI takes effect on this container's
  // very next poll, not just for newly-fired alerts but for the same
  // warning/critical status AttentionBanner shows too — one threshold, not
  // a UI one and a separate baked-in one that quietly disagree.
  const memWarningPercent = state.alertConfig.thresholds.memWarningPercent;
  const memCriticalPercent = state.alertConfig.thresholds.memCriticalPercent;
  let containers;
  try {
    containers = await listContainers();
  } catch {
    return; // Docker unreachable this cycle — leave the cache as last-known-good
  }
  const targets = containers.filter((c) => watchedNames.has(c.name));
  // Collected during the loop below, then written to state.json ONCE after
  // Promise.all settles (not inline per-container) — targets.map runs its
  // async bodies concurrently, and a loadState()/saveState() pair from
  // inside each one could race and clobber a sibling's write. A single
  // read-modify-write after everything's done avoids that entirely.
  const newDeployMarkers = [];
  await Promise.all(
    targets.map(async (c) => {
      try {
        const [stats, inspected] = await Promise.all([fetchContainerStatsOnce(c.id), inspectContainer(c.id)]);
        const cpuPercent = computeCpuPercent(stats);
        const memUsageBytes = computeMemUsage(stats);
        // HostConfig.Memory is the limit someone actually SET (0 means
        // none configured) — the stats endpoint's own memory_stats.limit
        // falls back to reporting ~the host's total RAM when nothing was
        // configured, which isn't a threshold anyone chose, just an
        // artifact of there being no cap. Only compute a percent-of-limit
        // (and only then is a warning/critical status meaningful) when a
        // real limit exists — otherwise this just reports raw usage.
        const configuredLimit =
          inspected && inspected.HostConfig && inspected.HostConfig.Memory > 0 ? inspected.HostConfig.Memory : null;
        const memPercent = configuredLimit ? (memUsageBytes / configuredLimit) * 100 : null;
        let status = 'ok';
        if (memPercent !== null) {
          if (memPercent >= memCriticalPercent) status = 'critical';
          else if (memPercent >= memWarningPercent) status = 'warning';
        }

        // Net/disk I/O: Docker reports these as cumulative counters, not
        // rates — diff against whatever this same container reported last
        // poll (containerIoPrev) to get bytes/sec, same idea as CPU's own
        // cpu_stats/precpu_stats pairing but done by hand across polls since
        // a single stats call has no "pre" value for these two. First-ever
        // sample for a container has nothing to diff against, so all four
        // rates come back null that one cycle rather than a misleading
        // "0 B/s" — same convention pollBeylaRedMetrics uses for its first
        // RED-metrics sample.
        const nowMs = Date.now();
        const netTotals = computeNetIoTotals(stats);
        const blkTotals = computeBlkIoTotals(stats);
        const prevIo = containerIoPrev.get(c.id);
        let netRxRateBps = null;
        let netTxRateBps = null;
        let blkReadRateBps = null;
        let blkWriteRateBps = null;
        if (prevIo) {
          const deltaSec = (nowMs - prevIo.atMs) / 1000;
          if (deltaSec > 0) {
            netRxRateBps = Math.max(0, netTotals.rxBytes - prevIo.netRxBytes) / deltaSec;
            netTxRateBps = Math.max(0, netTotals.txBytes - prevIo.netTxBytes) / deltaSec;
            blkReadRateBps = Math.max(0, blkTotals.readBytes - prevIo.blkReadBytes) / deltaSec;
            blkWriteRateBps = Math.max(0, blkTotals.writeBytes - prevIo.blkWriteBytes) / deltaSec;
          }
        }
        containerIoPrev.set(c.id, {
          netRxBytes: netTotals.rxBytes,
          netTxBytes: netTotals.txBytes,
          blkReadBytes: blkTotals.readBytes,
          blkWriteBytes: blkTotals.writeBytes,
          atMs: nowMs,
        });

        // Restart count alone doesn't say WHY a container restarted — a
        // service flapping from an OOM kill (needs more memory or a leak
        // fixed) and one that's crash-looping on a bug (needs a code fix)
        // and one that was just manually redeployed (nothing wrong at all)
        // all show the exact same "N restarts" number without this. Docker
        // keeps State.OOMKilled/State.ExitCode from the container's most
        // recent stop even after it's since restarted and is running again
        // — this is that reason, in the same three buckets Coroot/Datadog
        // surface for exactly this question.
        function describeLastExitReason(insp, count) {
          if (!insp || !insp.State || !count) return null;
          const state = insp.State;
          if (state.OOMKilled === true) return { kind: 'oom', label: 'OOM-killed' };
          if (typeof state.ExitCode === 'number' && state.ExitCode !== 0) {
            return { kind: 'crash', label: `crashed (exit ${state.ExitCode})` };
          }
          return { kind: 'manual', label: 'clean exit' };
        }

        // RestartCount is Docker's own count of restarts under this
        // container's restart policy (docker-compose.yml's `restart:`) —
        // zero extra bookkeeping needed, Docker already tracks it. A Coroot-
        // style stability signal: a container that's "up" right now but has
        // restarted 40 times today is a very different story from one
        // that's been running steadily. StartedAt reads "0001-01-01..."
        // (year 1, Go's zero-value time) when the container has never
        // started, so uptime is only computed while State.Running is true
        // AND StartedAt parses to a sane, non-zero date.
        const restartCount = inspected && typeof inspected.RestartCount === 'number' ? inspected.RestartCount : null;
        const lastExitReason = describeLastExitReason(inspected, restartCount);
        let uptimeSeconds = null;
        if (inspected && inspected.State && inspected.State.Running && inspected.State.StartedAt) {
          const startedMs = Date.parse(inspected.State.StartedAt);
          if (Number.isFinite(startedMs) && startedMs > 0) uptimeSeconds = Math.max(0, (nowMs - startedMs) / 1000);
        }

        // Deploy detection: `inspected.Image` is the resolved image ID
        // (sha256:...) the container was actually created from — this
        // changes whenever a `docker compose up -d` recreates the container
        // against a newly-pulled image, even if the image's TAG (e.g.
        // `myapp:latest`) stayed exactly the same, which is the normal case
        // and exactly why the tag alone can't be used for this. The first
        // time a container name is ever seen (lastKnownContainerImage has no
        // prior entry) is a baseline, not a deploy — recording one on every
        // engine restart would be noise, not signal.
        const imageId = inspected && inspected.Image ? inspected.Image : null;
        if (imageId) {
          const prevImageId = lastKnownContainerImage.get(c.name);
          if (prevImageId && prevImageId !== imageId) {
            newDeployMarkers.push({
              service: c.name,
              at: new Date().toISOString(),
              fromImage: prevImageId,
              toImage: imageId,
            });
          }
          lastKnownContainerImage.set(c.name, imageId);
        }

        containerHealthCache.set(c.id, {
          cpuPercent,
          memUsageBytes,
          memLimitBytes: configuredLimit,
          memPercent,
          status,
          netRxRateBps,
          netTxRateBps,
          blkReadRateBps,
          blkWriteRateBps,
          restartCount,
          lastExitReason,
          uptimeSeconds,
          checkedAt: new Date().toISOString(),
          error: null,
        });

        pushBoundedHistory(containerStatsHistory, c.id, {
          t: nowMs,
          cpuPercent,
          memPercent,
          memUsageBytes,
          netRxRateBps,
          netTxRateBps,
          blkReadRateBps,
          blkWriteRateBps,
        });
      } catch (err) {
        containerHealthCache.set(c.id, {
          cpuPercent: null,
          memUsageBytes: null,
          memLimitBytes: null,
          memPercent: null,
          status: 'unknown',
          netRxRateBps: null,
          netTxRateBps: null,
          blkReadRateBps: null,
          blkWriteRateBps: null,
          restartCount: null,
          lastExitReason: null,
          uptimeSeconds: null,
          checkedAt: new Date().toISOString(),
          error: describeFetchError(err),
        });
      }
    })
  );
  // Drop entries for containers no longer watched/gone, so an un-watched
  // or removed service doesn't keep showing a frozen last reading forever.
  const liveIds = new Set(targets.map((c) => c.id));
  for (const id of containerHealthCache.keys()) {
    if (!liveIds.has(id)) containerHealthCache.delete(id);
  }
  for (const id of containerIoPrev.keys()) {
    if (!liveIds.has(id)) containerIoPrev.delete(id);
  }
  for (const id of containerStatsHistory.keys()) {
    if (!liveIds.has(id)) containerStatsHistory.delete(id);
  }

  if (newDeployMarkers.length > 0) {
    for (const m of newDeployMarkers) {
      console.warn(`[deploy] detected new image for ${m.service}: ${m.fromImage.slice(0, 19)} -> ${m.toImage.slice(0, 19)}`);
    }
    // Fresh read-modify-write rather than reusing the `state` loaded at the
    // top of this function — this poll cycle can take several seconds
    // (Docker stats/inspect calls per container), long enough for a
    // settings-UI save to have landed in between, and this write must not
    // clobber that.
    const freshState = loadState();
    const combined = [...newDeployMarkers.reverse(), ...(freshState.deployMarkers || [])];
    freshState.deployMarkers = combined.slice(0, DEPLOY_MARKER_LIMIT);
    saveState(freshState);
  }
}

// ---- Alerts -----------------------------------------------------------
//
// Everything above this (checkStorage, pollContainerHealth, dockerHealthSignal)
// already computes a status — this section is just the "tell someone who
// isn't staring at the dashboard right now" layer on top of those existing
// signals. Deliberately its own independent setInterval (wired up at the
// bottom of this file, next to the other background pollers), NOT hooked
// into the /api/status request handler: /api/status only ever runs when a
// browser is actively polling it (App.jsx's POLL_MS), so an alert loop
// living inside it would silently stop alerting the exact moment nobody has
// the dashboard open — which defeats the entire point of alerting someone
// who isn't watching.
//
// "Sustained for N checks" (this project's explicit choice over firing on
// the very first bad reading): a condition has to stay breached across
// ALERT_SUSTAIN_CHECKS consecutive evaluation cycles before it actually
// fires, and clears the moment a single cycle comes back healthy. Avoids
// paging someone over one noisy blip (a container mid-restart, one slow
// Docker stats call) while still catching anything that's actually stuck.
const ALERT_EVAL_INTERVAL_MS = 15000;
const ALERT_HISTORY_LIMIT = 200;

// Everything below (sustain window, per-trigger on/off, CPU/memory
// thresholds, which channels to notify and their credentials) used to be
// env-var-only — fine for one person setting podotype up once via
// docker-compose.yml, not fine for "let people change this from the UI"
// (this project's own explicit ask). These four stay as env vars ONLY as
// the seed for the very first run; see defaultAlertConfig/loadState below
// for how state.json (edited via GET/POST /api/alerts/config, same file
// every other per-service setting already lives in) takes over after that.
const ALERT_SUSTAIN_CHECKS_DEFAULT = parseInt(process.env.ALERT_SUSTAIN_CHECKS || '3', 10);
const CPU_WARNING_PERCENT_DEFAULT = parseInt(process.env.CPU_WARNING_PERCENT || '85', 10);
const CPU_CRITICAL_PERCENT_DEFAULT = parseInt(process.env.CPU_CRITICAL_PERCENT || '95', 10);
// RED-metric alerting (error rate + p95 latency) — added alongside CPU/mem/
// storage/service-down because those four only ever catch INFRASTRUCTURE
// failures (container crashed, disk full, host under load). A service can
// be "up", using normal CPU/memory, and still be actively broken — returning
// 50% 5xx, or answering ten times slower than usual — and none of the
// existing triggers would ever fire for that. Both signals already exist
// elsewhere in this file (redMetricsForBeylaTarget for error rate,
// traceSignal's p95Ms for latency, both fed by Beyla's always-on RED
// metrics) — this just lets evaluateAlerts judge them the same
// sustain-N-checks way it already judges CPU/memory. errorRate is a
// FRACTION (Beyla-native, e.g. 0.05 = 5%) internally but expressed as a
// percent (0-100) in config/UI, same convention as CPU/mem percent
// thresholds, for one consistent unit across the whole settings screen.
const ERROR_RATE_WARNING_PERCENT_DEFAULT = parseInt(process.env.ERROR_RATE_WARNING_PERCENT || '5', 10);
const ERROR_RATE_CRITICAL_PERCENT_DEFAULT = parseInt(process.env.ERROR_RATE_CRITICAL_PERCENT || '20', 10);
// Latency thresholds default off SLOW_THRESHOLD_MS (the same "is this
// service slow" bar already shown elsewhere on the dashboard) for warning,
// with critical at 3x that — arbitrary but a reasonable first cut; both are
// user-editable from the Alerts settings UI same as every other threshold.
const LATENCY_WARNING_MS_DEFAULT = parseInt(process.env.LATENCY_WARNING_MS || String(SLOW_THRESHOLD_MS), 10);
const LATENCY_CRITICAL_MS_DEFAULT = parseInt(process.env.LATENCY_CRITICAL_MS || String(SLOW_THRESHOLD_MS * 3), 10);
const ALERT_TELEGRAM_BOT_TOKEN_DEFAULT = process.env.ALERT_TELEGRAM_BOT_TOKEN || '';
const ALERT_TELEGRAM_CHAT_ID_DEFAULT = process.env.ALERT_TELEGRAM_CHAT_ID || '';
const ALERT_WEBHOOK_URL_DEFAULT = process.env.ALERT_WEBHOOK_URL || '';
// Generic SMTP sender credentials for the email alert channel — works
// with Gmail, Google Workspace, Zoho Mail, Outlook/Microsoft 365, or any
// other provider's SMTP server, since it's just host/port/user/password
// rather than anything Gmail-specific. See sendEmailNotification's own
// comment for why self-hosted asks for real mailbox credentials rather
// than sending on podotype's behalf the way the hosted side does.
const ALERT_EMAIL_SMTP_HOST_DEFAULT = process.env.ALERT_EMAIL_SMTP_HOST || '';
const ALERT_EMAIL_SMTP_PORT_DEFAULT = parseInt(process.env.ALERT_EMAIL_SMTP_PORT || '465', 10);
const ALERT_EMAIL_SMTP_USER_DEFAULT = process.env.ALERT_EMAIL_SMTP_USER || '';
const ALERT_EMAIL_SMTP_PASSWORD_DEFAULT = process.env.ALERT_EMAIL_SMTP_PASSWORD || '';
const ALERT_EMAIL_TO_DEFAULT = process.env.ALERT_EMAIL_TO || '';

// The full editable shape behind the Alerts settings UI (GET/POST
// /api/alerts/config) — four trigger on/off switches, the two threshold
// pairs evaluateAlerts actually checks against, the sustain-window size,
// and per-channel enabled+credentials. Called once by loadState() whenever
// state.json has no alertConfig yet (first run) or is missing individual
// fields (an older state.json saved before a field existed) — see
// loadState's own merge below for why this is a function and not a plain
// object literal (env vars are read once at process start, so baking this
// into a literal would freeze in whatever the FIRST container's env
// happened to be rather than re-reading it — not actually a concern since
// this only ever runs at module load either way, but keeping it a function
// mirrors getServiceEntry's own shape for a similar per-entry default).
function defaultAlertConfig() {
  return {
    // errorRate/latency default OFF, unlike the infra triggers: those need a
    // service to actually be receiving traffic and reporting real RED
    // metrics before they mean anything, whereas CPU/memory/service-down are
    // meaningful from the very first poll. Left for the person to switch on
    // once they've confirmed Beyla is seeing real request traffic for the
    // service they care about (the same "eBPF Data" panel already shows
    // this) — an error-rate alert firing off zero real samples would just be
    // noise.
    enabled: { serviceDown: true, storage: true, cpu: true, memory: true, errorRate: false, latency: false },
    thresholds: {
      cpuWarningPercent: CPU_WARNING_PERCENT_DEFAULT,
      cpuCriticalPercent: CPU_CRITICAL_PERCENT_DEFAULT,
      memWarningPercent: MEM_WARNING_PERCENT_DEFAULT,
      memCriticalPercent: MEM_CRITICAL_PERCENT_DEFAULT,
      errorRateWarningPercent: ERROR_RATE_WARNING_PERCENT_DEFAULT,
      errorRateCriticalPercent: ERROR_RATE_CRITICAL_PERCENT_DEFAULT,
      latencyWarningMs: LATENCY_WARNING_MS_DEFAULT,
      latencyCriticalMs: LATENCY_CRITICAL_MS_DEFAULT,
      // Absolute-memory-usage thresholds, in MB — null (not just "high") by
      // default, deliberately NOT given a global default the way CPU/mem
      // percent are: percent-of-configured-limit already covers "using too
      // much of what I gave it," but plenty of containers run with NO
      // configured Docker memory limit at all (memPercent stays null for
      // those forever — see pollContainerHealth's configuredLimit comment),
      // and "alert if this specific service ever uses more than 500MB" is a
      // per-service judgment call with no sane one-size-fits-all number.
      // Meant to be set per-service via alertOverrides (see "Per-service
      // alert overrides" below), though nothing stops setting it globally
      // here too if every service really does share the same budget.
      memWarningMb: null,
      memCriticalMb: null,
    },
    sustainChecks: ALERT_SUSTAIN_CHECKS_DEFAULT,
    channels: {
      telegram: {
        enabled: Boolean(ALERT_TELEGRAM_BOT_TOKEN_DEFAULT && ALERT_TELEGRAM_CHAT_ID_DEFAULT),
        botToken: ALERT_TELEGRAM_BOT_TOKEN_DEFAULT,
        chatId: ALERT_TELEGRAM_CHAT_ID_DEFAULT,
      },
      webhook: { enabled: Boolean(ALERT_WEBHOOK_URL_DEFAULT), url: ALERT_WEBHOOK_URL_DEFAULT },
      // Bring-your-own mailbox, same reasoning as Telegram's bot token
      // above — this install has no sending identity of its own, so
      // whoever runs it supplies one: any SMTP provider (Gmail, Google
      // Workspace, Zoho Mail, Outlook, a cPanel mailbox, ...), plus an
      // app-specific password if that provider requires one once 2FA is
      // on (most do — Gmail/Workspace at myaccount.google.com/apppasswords,
      // Zoho Mail under Security > App Passwords, etc.).
      email: {
        enabled: Boolean(
          ALERT_EMAIL_SMTP_HOST_DEFAULT && ALERT_EMAIL_SMTP_USER_DEFAULT && ALERT_EMAIL_SMTP_PASSWORD_DEFAULT && ALERT_EMAIL_TO_DEFAULT
        ),
        smtpHost: ALERT_EMAIL_SMTP_HOST_DEFAULT,
        smtpPort: ALERT_EMAIL_SMTP_PORT_DEFAULT,
        smtpUser: ALERT_EMAIL_SMTP_USER_DEFAULT,
        smtpPassword: ALERT_EMAIL_SMTP_PASSWORD_DEFAULT,
        to: ALERT_EMAIL_TO_DEFAULT,
      },
    },
  };
}

// conditionKey -> { consecutiveBreaches, active }. One entry per condition
// this project tracks (one per watched service's up/down, one for storage,
// one per watched container's CPU, one per watched container's memory) —
// NOT per fired alert, so a condition that's currently healthy still has an
// entry sitting at consecutiveBreaches: 0.
let alertConditionState = new Map();
// conditionKey -> the alert object while it's actively firing. Removed the
// moment the condition resolves (see evaluateAlertCondition below) — this
// is "what's wrong right now", not a log.
let activeAlerts = new Map();
// Bounded log of fired/resolved events, newest first — what a "what set off
// that Telegram message an hour ago" question gets answered from, since
// activeAlerts itself has already forgotten anything that's since resolved.
let alertHistory = [];

function pushAlertHistory(event, alert) {
  const entry = { event, at: new Date().toISOString(), ...alert };
  alertHistory.unshift(entry);
  if (alertHistory.length > ALERT_HISTORY_LIMIT) alertHistory.length = ALERT_HISTORY_LIMIT;
  // Persisted now (previously in-memory only — see this array's own
  // declaration comment, which was true until now) so the Incidents page
  // survives a container restart instead of losing everything the moment
  // the process recycles. Same fresh-read-modify-write pattern
  // recordDeployMarkers uses just above for the same reason (this can run
  // from the middle of a multi-second evaluation pass, long enough for a
  // concurrent settings save to land in between).
  try {
    const freshState = loadState();
    freshState.alertHistory = [entry, ...(freshState.alertHistory || [])].slice(0, ALERT_HISTORY_LIMIT);
    saveState(freshState);
  } catch (err) {
    console.warn(`[alerts] failed to persist alert history: ${err.message}`);
  }
}

// Both notification functions take the channel's own config slice (not a
// module-level constant — see defaultAlertConfig above, this can change at
// any time via the settings UI) and, unlike the fire-and-forget shape this
// used to have, return { ok, error } so /api/alerts/test (below) can report
// a REAL pass/fail back to whoever just typed in a bot token, rather than
// asking them to take "saved" on faith and wait for a real alert to find
// out whether it actually works — same "don't assume, confirm" bar the rest
// of this branch has been held to.
async function sendTelegramMessage(text, cfg) {
  if (!cfg || !cfg.enabled || !cfg.botToken || !cfg.chatId) return { ok: false, error: 'not configured' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const error = `HTTP ${res.status}: ${body.slice(0, 200)}`;
      console.warn(`[alerts] Telegram notify failed: ${error}`);
      return { ok: false, error };
    }
    return { ok: true, error: null };
  } catch (err) {
    console.warn(`[alerts] Telegram notify error: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function sendWebhookNotification(text, cfg) {
  if (!cfg || !cfg.enabled || !cfg.url) return { ok: false, error: 'not configured' };
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Both `text` (Slack incoming-webhook shape) and `content` (Discord's)
      // in the same payload so one URL works against either without
      // podotype needing to know or ask which service is on the other end.
      body: JSON.stringify({ text, content: text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const error = `HTTP ${res.status}: ${body.slice(0, 200)}`;
      console.warn(`[alerts] webhook notify failed: ${error}`);
      return { ok: false, error };
    }
    return { ok: true, error: null };
  } catch (err) {
    console.warn(`[alerts] webhook notify error: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// Plain SMTP, not tied to Gmail — works against Gmail/Google Workspace,
// Zoho Mail, Outlook/Microsoft 365, or any other provider by pointing
// host/port at that provider's own SMTP server (port 465 is "implicit
// TLS", the common default; 587 is STARTTLS, also common — secure is
// derived from the port rather than asked separately, one less field to
// get wrong). Self-hosted has no sending identity of its own to lean on
// the way the hosted side can (see ../hosted/license-server/notifiers.js's
// sendEmail comment, which sends through podotype's own operator mailbox
// instead) — there's no "podotype operator" running this install, so
// whoever sets this up supplies their own mailbox as the sender, same
// "bring your own credentials" shape as Telegram's bot token above. A
// fresh transporter per send (not cached at module scope) because any of
// these fields can change between saves via the settings UI, and alert
// emails are infrequent enough that the extra connection setup never
// matters.
async function sendEmailNotification(subject, text, cfg) {
  if (!cfg || !cfg.enabled || !cfg.smtpHost || !cfg.smtpUser || !cfg.smtpPassword || !cfg.to) {
    return { ok: false, error: 'not configured' };
  }
  try {
    const port = Number(cfg.smtpPort) || 465;
    const transporter = nodemailer.createTransport({
      host: cfg.smtpHost,
      port,
      secure: port === 465,
      auth: { user: cfg.smtpUser, pass: cfg.smtpPassword },
    });
    await transporter.sendMail({
      from: `"podotype alerts" <${cfg.smtpUser}>`,
      to: cfg.to,
      subject,
      text,
    });
    return { ok: true, error: null };
  } catch (err) {
    console.warn(`[alerts] email notify error: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// Fire-and-forget from evaluateAlertCondition's own call sites (a real alert
// firing shouldn't block on Telegram's API being slow) — /api/alerts/test
// calls the two send functions directly instead, since IT needs the result.
function notifyAlert(alert, event, channels) {
  const text =
    event === 'fired' ? `🔴 podotype alert: ${alert.message}` : `✅ podotype: ${alert.message} — resolved`;
  sendTelegramMessage(text, channels.telegram);
  sendWebhookNotification(text, channels.webhook);
  sendEmailNotification(text, text, channels.email);
}

// The one piece of logic every alert condition shares: sustain-N-checks to
// fire, clear-on-first-good-check to resolve. `meta` is recomputed by the
// caller every cycle (so severity/message can escalate — e.g. warning ->
// critical — without losing the sustain counter or double-firing) but only
// actually used the moment the condition (re)fires or while it stays active.
// `sustainChecks`/`channels` are passed in fresh from the current
// alertConfig on every call rather than read from a module constant, since
// either can change between cycles via the settings UI.
function evaluateAlertCondition(key, breached, meta, sustainChecks, channels) {
  const state = alertConditionState.get(key) || { consecutiveBreaches: 0, active: false };
  if (breached) {
    state.consecutiveBreaches += 1;
    if (!state.active && state.consecutiveBreaches >= sustainChecks) {
      state.active = true;
      const alert = {
        key,
        ...meta,
        firstBreachAt: new Date(Date.now() - (state.consecutiveBreaches - 1) * ALERT_EVAL_INTERVAL_MS).toISOString(),
        firedAt: new Date().toISOString(),
      };
      activeAlerts.set(key, alert);
      pushAlertHistory('fired', alert);
      notifyAlert(alert, 'fired', channels);
    } else if (state.active) {
      // Still breached — refresh in place (severity may have gotten worse,
      // e.g. warning -> critical) without re-running the sustain counter or
      // sending a second "fired" notification for the same ongoing issue.
      const existing = activeAlerts.get(key);
      if (existing) Object.assign(existing, meta);
    }
  } else if (state.active) {
    const existing = activeAlerts.get(key);
    activeAlerts.delete(key);
    state.active = false;
    state.consecutiveBreaches = 0;
    if (existing) {
      pushAlertHistory('resolved', existing);
      notifyAlert(existing, 'resolved', channels);
    }
  } else {
    state.consecutiveBreaches = 0;
  }
  alertConditionState.set(key, state);
}

// Runs every ALERT_EVAL_INTERVAL_MS (wired up at the bottom of this file),
// reading the same state everything else here already maintains
// (storageStatus, containerHealthCache, dockerHealthSignal, activeChecks) —
// this function doesn't poll anything itself, it just judges what those
// pollers already found, against whatever alertConfig is currently saved.
// A trigger switched OFF in the settings UI isn't specialcased here beyond
// always passing `breached: false` for it — that naturally resolves (and
// notifies "resolved" on) any alert that was active when it got disabled,
// rather than leaving a phantom "active" alert nobody can see clear.
// ---- Per-service alert overrides -----------------------------------------
//
// Everything evaluateAlerts checked against, up to this point, was ONE
// global set of thresholds applied identically to every watched service —
// fine as a starting point, but a real ask this project heard directly:
// "I want service 1 to alert if it exceeds 500MB RAM," a number that's
// specific to that one service, not something every other watched
// container should also be held to. `entry.alertOverrides` (stored per
// service, alongside its `check`/`metrics`/`otel`/`logStorage` settings —
// see getServiceEntry) is an OPTIONAL, PARTIAL override of the same
// `{ enabled, thresholds }` shape as the global alertConfig: any key present
// there wins for that one service; anything absent falls through to
// whatever's globally configured, so setting one custom number for one
// service never requires re-specifying every other threshold for it too.
function effectiveAlertSettingsForService(globalConfig, entry) {
  const overrides = (entry && entry.alertOverrides) || {};
  return {
    enabled: { ...globalConfig.enabled, ...(overrides.enabled || {}) },
    thresholds: { ...globalConfig.thresholds, ...(overrides.thresholds || {}) },
  };
}

async function evaluateAlerts() {
  const state = loadState();
  const { sustainChecks, channels } = state.alertConfig;
  const watchedEntries = Object.entries(state.services).filter(([, e]) => e.watched);

  let containers = [];
  try {
    containers = await listContainers();
  } catch {
    // Docker unreachable this cycle — skip service-down/CPU/memory checks
    // rather than treat "we couldn't ask" as "it's down"; storage's own
    // check has already run independently of Docker either way.
  }
  const byName = new Map(containers.map((c) => [c.name, c]));

  for (const [name, entry] of watchedEntries) {
    const container = byName.get(name) || null;
    // Per-service effective settings — see effectiveAlertSettingsForService's
    // comment. Every condition below this point (service-down, RED, CPU,
    // memory, memory-MB) reads from THIS, not state.alertConfig directly, so
    // a per-service override actually takes effect; only the storage
    // condition after this loop stays on the plain global config, since
    // ClickHouse's disk isn't a per-service concept.
    const { enabled, thresholds } = effectiveAlertSettingsForService(state.alertConfig, entry);
    const checkEntry = activeChecks.get(name);
    const checkResult = checkEntry ? checkEntry.result : null;
    let up = null;
    if (entry.check && checkResult) up = checkResult.up;
    else if (!entry.check) up = dockerHealthSignal(container).up;
    // up === null covers "no data yet" and Docker's own ambiguous
    // restarting/paused/created states (see dockerHealthSignal) — neither
    // is evidence the service is actually down, so neither counts as a
    // breach here, same as dockerHealthSignal itself refuses to guess.
    evaluateAlertCondition(
      `service-down:${name}`,
      enabled.serviceDown && up === false,
      { kind: 'service-down', service: name, severity: 'critical', message: `${name} appears to be down` },
      sustainChecks,
      channels
    );

    // RED-metric alerts (error rate, latency) — evaluated from whatever this
    // container's own Beyla-resolved name/instance ids turn out to be, same
    // resolution used by /api/status (see that handler's comment for why
    // both a direct-name trace lookup AND a Beyla-runtime-name lookup are
    // needed). Deliberately NOT gated on `container` existing the way
    // CPU/memory below are — a container that briefly vanished from
    // `listContainers()` this cycle can still have fresh RED data sitting in
    // redMetricsCurrent from the last successful Beyla scrape, and there's
    // no reason to suppress a real ongoing error-rate spike just because
    // this one poll's Docker list call was flaky.
    if (name) {
      let beylaName = null;
      let beylaInstanceIds = null;
      if (container) {
        beylaName = resolveBeylaServiceName(container);
        if (beylaName) beylaInstanceIds = resolveBeylaInstanceIds(container);
      }
      const red = beylaName ? redMetricsForBeylaTarget(beylaName, beylaInstanceIds) : null;
      if (red && red.requestsPerSec > 0) {
        const errPercent = red.errorRate * 100;
        const errSeverity =
          errPercent >= thresholds.errorRateCriticalPercent
            ? 'critical'
            : errPercent >= thresholds.errorRateWarningPercent
              ? 'warning'
              : 'ok';
        evaluateAlertCondition(
          `error-rate:${name}`,
          enabled.errorRate && errSeverity !== 'ok',
          {
            kind: 'error-rate',
            service: name,
            severity: errSeverity,
            message: `${name} error rate at ${errPercent.toFixed(1)}% (${red.requestsPerSec.toFixed(1)} req/s)`,
          },
          sustainChecks,
          channels
        );
      }

      // Latency reuses traceSignal — the same ClickHouse-backed p95 already
      // computed for the dashboard's own "is this service slow" indicator —
      // rather than a second, separate query. Tried first under the
      // container's own name (a manual OTel agent, or a service that set its
      // own OTEL_SERVICE_NAME), then under its Beyla runtime name, same
      // fallback order /api/status uses.
      let trace = await traceSignal(name);
      if ((!trace || trace.status === 'no-data') && beylaName && beylaName !== name) {
        trace = await traceSignal(beylaName, beylaInstanceIds);
      }
      // Sampled into latencyHistory regardless of whether this reading
      // breaches any alert threshold below — the Traces tab's sparkline
      // wants the real trend line, not just the moments it crossed into
      // warning/critical.
      if (trace && trace.p95Ms !== null) {
        pushBoundedHistory(latencyHistory, name, { t: Date.now(), p50Ms: trace.p50Ms, p95Ms: trace.p95Ms, p99Ms: trace.p99Ms });
      }
      if (trace && trace.p95Ms !== null) {
        const latSeverity =
          trace.p95Ms >= thresholds.latencyCriticalMs
            ? 'critical'
            : trace.p95Ms >= thresholds.latencyWarningMs
              ? 'warning'
              : 'ok';
        evaluateAlertCondition(
          `latency:${name}`,
          enabled.latency && latSeverity !== 'ok',
          {
            kind: 'latency',
            service: name,
            severity: latSeverity,
            message: `${name} p95 latency at ${Math.round(trace.p95Ms)}ms`,
          },
          sustainChecks,
          channels
        );
      }
    }

    if (!container) continue;
    const health = containerHealthCache.get(container.id);
    if (!health) continue;

    if (health.cpuPercent !== null) {
      const cpuSeverity =
        health.cpuPercent >= thresholds.cpuCriticalPercent
          ? 'critical'
          : health.cpuPercent >= thresholds.cpuWarningPercent
            ? 'warning'
            : 'ok';
      evaluateAlertCondition(
        `cpu:${name}`,
        enabled.cpu && cpuSeverity !== 'ok',
        { kind: 'cpu', service: name, severity: cpuSeverity, message: `${name} CPU at ${Math.round(health.cpuPercent)}%` },
        sustainChecks,
        channels
      );
    }

    // Severity computed HERE, from thresholds (the per-service EFFECTIVE
    // ones), rather than trusting health.status — health.status is set by
    // pollContainerHealth against the GLOBAL thresholds only (it has no
    // per-service entry to resolve an override from at that point), so
    // reusing it here would silently ignore a per-service memory-percent
    // override. Same pattern the CPU condition just above already uses.
    // Only meaningful (non-null) when the container has a configured
    // memory limit — same gating pollContainerHealth itself applies.
    if (health.memPercent !== null) {
      const memSeverity =
        health.memPercent >= thresholds.memCriticalPercent
          ? 'critical'
          : health.memPercent >= thresholds.memWarningPercent
            ? 'warning'
            : 'ok';
      evaluateAlertCondition(
        `memory:${name}`,
        enabled.memory && memSeverity !== 'ok',
        { kind: 'memory', service: name, severity: memSeverity, message: `${name} memory at ${Math.round(health.memPercent)}%` },
        sustainChecks,
        channels
      );
    }

    // Absolute-memory-MB condition — see defaultAlertConfig's memWarningMb/
    // memCriticalMb comment for why this exists alongside the percent-based
    // check above: it works with NO Docker memory limit configured (the
    // percent check above is a no-op then, since health.memPercent stays
    // null), and it's what actually answers the literal ask — "alert me if
    // this service uses more than 500MB" — with a number chosen for THIS
    // service, via alertOverrides, not a global one. Gated on the threshold
    // actually being set (non-null): unlike percent thresholds, there's no
    // sane global default for an absolute byte count, so "not configured"
    // has to mean "don't evaluate this," not "compare against zero."
    if (health.memUsageBytes !== null && (thresholds.memWarningMb !== null || thresholds.memCriticalMb !== null)) {
      const memMb = health.memUsageBytes / (1024 * 1024);
      const critMb = thresholds.memCriticalMb;
      const warnMb = thresholds.memWarningMb;
      const mbSeverity =
        critMb !== null && memMb >= critMb ? 'critical' : warnMb !== null && memMb >= warnMb ? 'warning' : 'ok';
      evaluateAlertCondition(
        `memory-mb:${name}`,
        enabled.memory && mbSeverity !== 'ok',
        { kind: 'memory-mb', service: name, severity: mbSeverity, message: `${name} memory at ${Math.round(memMb)}MB` },
        sustainChecks,
        channels
      );
    }
  }

  // Drop latencyHistory entries for services no longer watched, same
  // "stop growing a map for something nobody's looking at anymore" reasoning
  // redMetricsHistory's own cleanup applies (see pollBeylaRedMetrics) — just
  // keyed off the watchlist directly here since that's already in scope,
  // rather than off a Beyla scrape disappearing.
  const watchedNames = new Set(watchedEntries.map(([name]) => name));
  for (const key of latencyHistory.keys()) {
    if (!watchedNames.has(key)) latencyHistory.delete(key);
  }

  evaluateAlertCondition(
    'storage',
    state.alertConfig.enabled.storage && (storageStatus.status === 'warning' || storageStatus.status === 'critical'),
    { kind: 'storage', service: null, severity: storageStatus.status, message: `ClickHouse disk is ${storageStatus.usedPercent}% full` },
    sustainChecks,
    channels
  );
}

// ---- Raw log viewer (read-only tail, no parsing) ---------------------------
//
// Different from logMetricsForContainer above on purpose: that one greps
// for one specific format to derive a number; this shows a person the
// actual lines, whatever they look like, the same thing `docker logs`
// would show. `timestamps=true` asks Docker to prefix each line with its
// own RFC3339Nano timestamp, which parseDockerLogLine below splits back
// out so the UI can show a relative time without parsing app-specific log
// formats itself.
const LOG_TAIL_LINES_DEFAULT = 200;
const LOG_TAIL_LINES_MAX = 1000;

function parseDockerLogLine(line) {
  const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s(.*)$/.exec(line);
  if (m) return { ts: m[1], line: m[2] };
  return { ts: null, line };
}

// ---- Log clustering: group similar lines instead of showing N copies ------
//
// Real services log the same handful of message SHAPES over and over with
// different values plugged in ("user 4821 logged in", "user 9012 logged
// in", timing numbers, request ids, ...) — a raw tail just repeats each
// shape N times, burying anything genuinely different underneath whichever
// message happens to fire most often. This groups lines by a normalized
// TEMPLATE (numbers, UUIDs, hashes, IPs and quoted values replaced with
// placeholders) so a noisy tail collapses into a handful of distinct
// patterns with a count each — the same idea log-analysis tools like
// Drain/LogCluster use, simplified here to a placeholder-substitution pass
// rather than a trained/streaming model, which is plenty for "what are the
// N shapes of line this container actually logs" on a self-hosted box.
const LOG_CLUSTER_TAIL_DEFAULT = 500;
const LOG_CLUSTER_TAIL_MAX = 2000;
const LOG_CLUSTER_LIMIT = 50; // most-frequent shapes only — a container with truly unique lines every time isn't a clustering problem to begin with

// Order matters: more specific patterns (UUID, long hex/hash, IP) run
// before the generic number pattern, so e.g. a UUID's digit runs don't get
// partially swallowed by <NUM> first and left as an odd half-templated
// remnant like "<NUM>a<NUM>b-<NUM>...".
function normalizeLogLine(line) {
  return line
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<UUID>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<IP>')
    .replace(/\b[0-9a-fA-F]{12,}\b/g, '<HEX>')
    .replace(/"[^"]*"/g, '"<STR>"')
    .replace(/'[^']*'/g, "'<STR>'")
    // No \b around the digits here on purpose (confirmed live against a
    // test line before shipping): \b only matches between a word and a
    // non-word character, so a value glued directly to a unit or suffix —
    // "42ms", "550e8400" already handled above, "v2beta1" — has NO
    // boundary between the digits and the letters on either side, and a
    // \b-anchored version silently left those completely unreplaced,
    // defeating clustering on exactly the kind of line ("took 42ms",
    // "took 55ms") this feature most needs to collapse.
    .replace(/\d+(\.\d+)?/g, '<NUM>')
    .replace(/\s+/g, ' ')
    .trim();
}

// Best-effort severity guess from the raw line text — most app loggers put
// the level as a plain word near the start ("ERROR", "[warn]", "level=info"),
// so a case-insensitive word match catches the common cases without trying
// to parse every framework's own log format (same "don't overfit to one
// format" stance ACCESS_LOG_RE above already takes).
const LOG_LEVEL_RANK = { info: 0, warning: 1, error: 2, fatal: 3 };
function classifyLogLevel(line) {
  if (/\b(fatal|panic)\b/i.test(line)) return 'fatal';
  if (/\b(error|exception|err)\b/i.test(line)) return 'error';
  if (/\b(warn|warning)\b/i.test(line)) return 'warning';
  return 'info';
}

// entries: [{ts, line}] as parseDockerLogLine produces. Returns clusters
// sorted busiest-first, each with the count, the worst severity seen for
// that shape, first/last-seen timestamps, and the most recent real line as
// a concrete example (a template alone — "user <NUM> logged in" — is
// useful for spotting the pattern, but the actual line is what you need to
// go investigate it).
function clusterLogLines(entries) {
  const clusters = new Map(); // template -> cluster
  for (const { ts, line } of entries) {
    if (!line) continue;
    const template = normalizeLogLine(line);
    const level = classifyLogLevel(line);
    const existing = clusters.get(template);
    if (existing) {
      existing.count += 1;
      if (ts) existing.lastTs = ts;
      if (!existing.firstTs && ts) existing.firstTs = ts;
      existing.sample = line;
      if (LOG_LEVEL_RANK[level] > LOG_LEVEL_RANK[existing.level]) existing.level = level;
    } else {
      clusters.set(template, { template, count: 1, level, firstTs: ts, lastTs: ts, sample: line });
    }
  }
  return [...clusters.values()].sort((a, b) => b.count - a.count);
}

// Live tail (`follow=true`), unlike the one-shot GET above — this keeps the
// Docker socket connection open and hands each new line to onLine as it's
// written, the same idea as `docker logs -f`. demuxDockerLogs (used by the
// one-shot route) can only run once a WHOLE response has arrived, since it
// needs the complete buffer up front — a live stream instead gets bytes in
// arbitrary-sized chunks that can split a frame header or a line's body
// right down the middle, so this keeps its own leftover-bytes buffer
// across chunks and only emits a line once a complete frame (or, for a
// non-framed/TTY container, a complete "\n"-terminated line) has actually
// arrived. Deliberately hand-rolled rather than piping through a library —
// same reasoning as dockerRequest above: this is a small, stable protocol,
// not worth a new dependency for.
function streamContainerLogs(containerId, { tail = 100 } = {}) {
  let onLineCb = () => {};
  let onErrorCb = () => {};
  let destroyed = false;
  let buf = Buffer.alloc(0);
  let framingDecided = false;
  let framed = true;
  let textCarry = '';

  function emitLines(text) {
    textCarry += text;
    let idx;
    while ((idx = textCarry.indexOf('\n')) !== -1) {
      const line = textCarry.slice(0, idx);
      textCarry = textCarry.slice(idx + 1);
      if (line.length > 0) onLineCb(line);
    }
  }

  function processChunk(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    if (!framingDecided) {
      if (buf.length < 8) return; // wait for enough bytes to tell
      // A real frame header's first byte is the stream type (0/1/2) and
      // the next three are always zero-padding — a container running
      // with a TTY skips this framing entirely and just sends raw bytes,
      // which this heuristic tells apart from a real header.
      framed = buf.readUInt8(0) <= 2 && buf.readUInt8(1) === 0 && buf.readUInt8(2) === 0 && buf.readUInt8(3) === 0;
      framingDecided = true;
    }
    if (!framed) {
      emitLines(buf.toString('utf8'));
      buf = Buffer.alloc(0);
      return;
    }
    while (buf.length >= 8) {
      const size = buf.readUInt32BE(4);
      if (buf.length < 8 + size) break; // frame body not fully arrived yet
      emitLines(buf.slice(8, 8 + size).toString('utf8'));
      buf = buf.slice(8 + size);
    }
  }

  const req = http.request(
    {
      socketPath: DOCKER_SOCKET,
      path: `/containers/${encodeURIComponent(containerId)}/logs?stdout=true&stderr=true&timestamps=true&follow=true&tail=${tail}`,
      method: 'GET',
    },
    (res) => {
      res.on('data', (chunk) => {
        if (!destroyed) processChunk(chunk);
      });
      res.on('end', () => {
        if (!destroyed) onErrorCb(new Error('log stream ended (container likely stopped)'));
      });
      res.on('error', (err) => {
        if (!destroyed) onErrorCb(err);
      });
    }
  );
  req.on('error', (err) => {
    if (!destroyed) onErrorCb(err);
  });
  req.end();

  return {
    onLine: (cb) => {
      onLineCb = cb;
    },
    onError: (cb) => {
      onErrorCb = cb;
    },
    destroy: () => {
      destroyed = true;
      req.destroy();
    },
  };
}

// ---- Log pattern storage (opt-in, per service) -----------------------------
//
// Everything above (Live tab, search, clustering) reads straight from
// Docker's own log files on demand — nothing about podotype stores a
// single byte of log data anywhere. That's cheap (zero incremental disk),
// but it means: log history dies with the container (a redeploy or
// crash-loop restart loses everything Docker had, since `docker logs` is
// tied to that specific container instance), "search" is bounded by
// whatever the host's Docker log driver happened to retain (unknown,
// uncontrolled by us), and clustering is a snapshot with no memory between
// views (no "this error's rate over the last 3 days" trend).
//
// This section is what actually fixes those, for whoever opts a service
// into it — but it's a REAL trade, not a free upgrade: it's a second copy
// of data Docker's own log driver already keeps its own copy of, so it
// only ever adds disk usage, it never reduces it (that's Docker's own log
// rotation config to fix, a separate concern this project doesn't touch
// per-service — see the OTel opt-in section below for the actual pattern
// for "a real config change, opt-in, per service, never silent"). Off by
// default for every service, on purpose, with a clear warning shown before
// anyone turns it on — see POST /api/services/:name/log-storage and
// LogsPanel.jsx's own toggle copy.
//
// What's actually stored is the CLUSTERED PATTERN, not raw lines — reusing
// normalizeLogLine/classifyLogLevel above, the exact same logic the
// on-the-fly Clustered Logs tab already uses — plus a running count and
// one example line, flushed to ClickHouse every LOG_PATTERN_FLUSH_INTERVAL_MS.
// For any real service, most lines are one of a handful of repeating
// shapes, so this is routinely a tiny fraction of what raw-line storage
// would cost — the trade-off being that only ONE example line survives
// per pattern per flush window, not every original line.
const LOG_PATTERN_FLUSH_INTERVAL_MS = parseInt(process.env.LOG_PATTERN_FLUSH_INTERVAL_MS || '30000', 10);

// serviceName -> { containerId, tailer, patterns: Map<template, {level, count, sample}> }
const logIngestState = new Map();

function stopLogIngest(serviceName) {
  const entry = logIngestState.get(serviceName);
  if (!entry) return;
  entry.tailer.destroy();
  logIngestState.delete(serviceName);
}

// tail: 0 — deliberately NOT replaying this container's existing log
// history into the aggregate. Enabling storage should start counting from
// "now", not silently backfill (and double-count against) whatever's
// already visible in the Live/Search tabs from before storage was ever
// turned on.
function startLogIngest(serviceName, containerId) {
  const patterns = new Map();
  const tailer = streamContainerLogs(containerId, { tail: 0 });
  tailer.onLine((rawLine) => {
    const { line } = parseDockerLogLine(rawLine);
    if (!line) return;
    const template = normalizeLogLine(line);
    const level = classifyLogLevel(line);
    const existing = patterns.get(template);
    if (existing) {
      existing.count += 1;
      existing.sample = line;
      if (LOG_LEVEL_RANK[level] > LOG_LEVEL_RANK[existing.level]) existing.level = level;
    } else {
      patterns.set(template, { level, count: 1, sample: line });
    }
  });
  tailer.onError((err) => {
    console.warn(`[engine] log ingest for "${serviceName}" stopped: ${err.message}`);
    // Don't retry here inline — reconcileLogIngestion's next tick sees this
    // entry is gone and starts a fresh tailer if the service is still
    // enabled and its container is still around (same recovery path as a
    // container restart, which also lands here via the same onError).
    logIngestState.delete(serviceName);
  });
  logIngestState.set(serviceName, { containerId, tailer, patterns });
}

// Runs on the same cadence as the other background pollers (see the
// bottom of this file) — starts a tailer for every watched service that's
// opted into log storage and doesn't have one running yet (including
// right after a container restart, since its container ID changes and the
// old tailer's onError above already cleared its stale entry), and stops
// any tailer whose service is no longer watched/opted-in or whose
// container no longer exists.
async function reconcileLogIngestion() {
  let state;
  try {
    state = loadState();
  } catch {
    return;
  }
  let containers;
  try {
    containers = await listContainers();
  } catch {
    return; // Docker unreachable this tick — leave existing tailers running, try again next tick
  }
  const containerByName = new Map(containers.map((c) => [c.name, c]));

  const wantIngest = new Set();
  for (const [name, entry] of Object.entries(state.services)) {
    if (!entry.watched || !entry.logStorage || !entry.logStorage.enabled) continue;
    const container = containerByName.get(name);
    if (!container || container.state !== 'running') continue;
    wantIngest.add(name);
    const running = logIngestState.get(name);
    if (running && running.containerId === container.id) continue; // already tailing the right container
    if (running) stopLogIngest(name); // stale container id (restarted) — drop and restart fresh below
    startLogIngest(name, container.id);
  }
  for (const name of [...logIngestState.keys()]) {
    if (!wantIngest.has(name)) stopLogIngest(name);
  }
}

// Flushes every service's accumulated pattern counts to ClickHouse as one
// row per (service, pattern) and clears the in-memory accumulator — NOT a
// clear-then-reset-to-empty-counts operation, an actual delete, since the
// next flush window starts counting that pattern fresh. Best-effort: a
// failed insert here just loses that one window's counts (logged, not
// thrown) rather than risking building up an ever-growing backlog against
// a ClickHouse that's down.
async function flushLogPatterns() {
  const nowStr = new Date().toISOString().replace('T', ' ').replace('Z', '');
  const rows = [];
  for (const [serviceName, entry] of logIngestState) {
    for (const [template, agg] of entry.patterns) {
      rows.push({
        Timestamp: nowStr,
        ServiceName: serviceName,
        Pattern: template,
        Level: agg.level,
        Count: agg.count,
        SampleLine: agg.sample,
      });
    }
    entry.patterns.clear();
  }
  if (rows.length === 0) return;
  try {
    const insertSql = `INSERT INTO ${CLICKHOUSE_LOG_PATTERNS_TABLE} FORMAT JSONEachRow`;
    const url = `${CLICKHOUSE_URL}/?database=${encodeURIComponent(CLICKHOUSE_DATABASE)}&query=${encodeURIComponent(insertSql)}`;
    const body = rows.map((r) => JSON.stringify(r)).join('\n');
    const res = await fetch(url, { method: 'POST', body });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[engine] log pattern insert failed: ${res.status} ${text.slice(0, 300)}`);
    }
  } catch (err) {
    console.warn(`[engine] log pattern insert failed: ${err.message}`);
  }
}

// Merges ClickHouse rows (grouped by Pattern AND Level, since ClickHouse
// can't itself pick "the worst level" across a GROUP BY the way
// LOG_LEVEL_RANK below can in JS) back into one row per pattern — same
// output shape clusterLogLines produces from a live tail, so
// LogsPanel.jsx's rendering doesn't need to know whether a given view came
// from a live tail or from stored history.
function mergeLogPatternRows(rows) {
  const byPattern = new Map();
  for (const row of rows) {
    const count = Number(row.count) || 0;
    const existing = byPattern.get(row.Pattern);
    if (!existing) {
      byPattern.set(row.Pattern, {
        template: row.Pattern,
        count,
        level: row.Level,
        firstTs: row.firstSeen,
        lastTs: row.lastSeen,
        sample: row.sample,
      });
      continue;
    }
    existing.count += count;
    if (LOG_LEVEL_RANK[row.Level] > LOG_LEVEL_RANK[existing.level]) existing.level = row.Level;
    if (row.firstSeen < existing.firstTs) existing.firstTs = row.firstSeen;
    if (row.lastSeen > existing.lastTs) {
      existing.lastTs = row.lastSeen;
      existing.sample = row.sample; // keep the most recent example
    }
  }
  return [...byPattern.values()].sort((a, b) => b.count - a.count);
}

// ---- OpenTelemetry opt-in (full traces, per service) -----------------------
//
// The one piece that's genuinely not zero-touch, on purpose: full
// distributed traces (spans, cross-service waterfalls) require something
// running inside the target process to create them, and nothing short of
// eBPF (which we dropped — see the top of this file) can do that from
// outside. An OTel auto-instrumentation agent is the standard, reliable
// way to do it with zero changes to the service's own source code — see
// root README "Why not eBPF" for how this compares to Beyla and to
// Datadog's Docker-daemon-level injection (which we deliberately didn't
// try to replicate: it requires taking over the host's Docker runtime,
// which is its own new fragile dependency, not a reduction of one).
//
// This never edits the user's compose file itself — it hands back a
// ready-to-use override (docker-compose.otel.yml) plus plain-English
// instructions, and the user applies it with one extra `-f` flag,
// per-service, only for the services they actually want traces from.
//
// Nothing to download by hand, either — and deliberately NOT by baking the
// agent into podotype's own image (an earlier version of this did that,
// then published it through a shared Docker volume). That approach coupled
// every supported language to an podotype image rebuild, and made the
// override depend on podotype having started at least once already. This
// version is self-contained instead: the generated override includes its
// own tiny one-shot fetch service (see generateOtelOverride below), which
// downloads the agent into a volume scoped to that one override, and the
// target service waits for it to finish (Compose's `depends_on: condition:
// service_completed_successfully`, needs Compose v2.20+ — current Docker
// Desktop has this) before it starts. So the download still happens
// automatically — it's just part of `docker compose up` on the CLIENT's
// own host, not a separate manual step, and not something podotype's own
// image has to carry. The two actual steps stay "save this file" and "run
// one docker compose command." This also means adding a new language later
// is just adding an entry below — no podotype image change needed.
//
// Java was the first language templated here, because it's the one this
// project actually tested end-to-end first (see root README "Status").
// Node.js is the second: also zero-source-code-change, but via a different
// OS-level mechanism, since Node has no single-file "-javaagent" equivalent.
// Node uses the OpenTelemetry Injector (open-telemetry/opentelemetry-injector)
// — a small, official, Apache-licensed shared library loaded via the Linux
// dynamic loader's LD_PRELOAD mechanism, which runs entirely inside the
// target container's own userspace. That's a deliberately different
// mechanism from Beyla/eBPF (removed from this project — see the top of this
// file): LD_PRELOAD is a standard per-process linker feature every container
// runtime supports, not a host-kernel probe, so it doesn't share Beyla's
// Docker-Desktop-virtualized-kernel failure mode. Once LD_PRELOAD'd, the
// injector still needs a real per-language auto-instrumentation agent to
// activate — for Node that's the official
// @opentelemetry/auto-instrumentations-node npm package, fetched into the
// same volume alongside the injector binary.
//
// Deliberately NOT built in-house: the injector does real, non-obvious
// systems-level work (per-arch ELF handling, safe LD_PRELOAD activation
// without crashing the host process) that upstream has already hardened
// across releases — e.g. v0.10.1 fixed a crash-on-attach on pre-glibc-2.34
// hosts (RHEL 8, Debian Bullseye). That's exactly the class of "silent
// breakage on someone else's machine" this project got burned by once
// already with Beyla on Docker Desktop, and upstream's already paid that
// cost so podotype doesn't have to relearn it. Consuming it here is the
// same trust relationship as consuming the upstream OTel Java agent jar for
// Java, below.
//
// Both the injector binary and the release tag are pinned deliberately, not
// floated to "latest" — same discipline this project settled on after the
// Beyla lesson: a fixed, tested version can't silently start failing on a
// clean re-run months from now just because upstream shipped a new build.
// Bump both together, after testing, when there's a reason to.
const OTEL_INJECTOR_VERSION = 'v0.11.0';
const OTEL_INJECTOR_BASE_URL = 'https://github.com/open-telemetry/opentelemetry-injector/releases/download';
const OTEL_AUTO_INSTRUMENTATIONS_NODE_VERSION = '0.80.0';
// Verified against the actual release asset list (releases/expanded_assets/v1.16.0)
// before pinning — GitHub's release page doesn't render asset names in a
// plain fetch, so this was checked directly rather than guessed. Assets are
// named "opentelemetry-dotnet-instrumentation-linux-{glibc,musl}-{x64,arm64}.zip".
const OTEL_DOTNET_INSTRUMENTATION_VERSION = 'v1.16.0';
const OTEL_DOTNET_INSTRUMENTATION_BASE_URL =
  'https://github.com/open-telemetry/opentelemetry-dotnet-instrumentation/releases/download';
// The gem itself, per rubygems.org: 0.1.0, first published September 2026,
// requires Ruby >= 3.3. Called out explicitly in Ruby's extraCaution below —
// unlike Java/Node/Python (each verified end-to-end against a real running
// service before being trusted here), this is new enough that podotype
// hasn't had the chance to do the same yet.
const OTEL_RUBY_AUTO_INSTRUMENTATION_VERSION = '0.1.0';

// Python is riskier than Java or Node, and shipped with that risk called out
// explicitly (see extraCaution below) rather than papered over: its OTel
// packages include compiled native extensions (grpcio, protobuf), so a
// bundle fetched for one libc (glibc) can't be loaded under another
// (musl/Alpine) — exactly the "works here, silently breaks there" failure
// mode this whole rework was about eliminating. Handled the same way the
// injector's own README handles it: build two separate bundles, one per
// libc flavor, and let the injector auto-detect which one the target
// process actually needs at startup. The bigger risk isn't the libc split
// though — it's that the injected bundle's own dependencies (protobuf,
// urllib3, requests, grpcio) sit in front of whatever version the target
// app already has installed on PYTHONPATH, and a mismatch there can break
// the target app's own imports, not just tracing. That's not a hypothetical
// podotype is downplaying — it's the OpenTelemetry Injector project's own
// documented warning for Python specifically ("not always safe to inject
// the additional Python packages due to possible dependency conflicts"),
// carried into the instructions text below (extraCaution) rather than left
// out.
//
// Verified for real before shipping (this sandbox is glibc/x86_64, so only
// the glibc half was execution-tested, not musl): built a real bundle with
// `pip install --target`, copied the auto-instrumentation package's own
// sitecustomize.py to the bundle root (that's what actually makes
// PYTHONPATH-prepend activate it — Python's site module auto-imports a
// top-level "sitecustomize" module at interpreter startup if one is on the
// path; the installed package only ships it nested inside
// opentelemetry/instrumentation/auto_instrumentation/, one directory copy
// short of working), then LD_PRELOAD'd the real injector .so into a real
// Flask app calling itself over HTTP with zero source changes — got back a
// real client span and a real server span, same trace ID, parent-child
// linked, exactly like the Node and Java tests.
//
// Every language entry below has the same shape so generateOtelOverride can
// stay generic: fetchServices is one or more one-shot init containers that
// populate a shared volume (mounted at mountDir in both every fetch service
// and the target service) — more than one only for Python, which needs a
// glibc build and a musl build side by side; env(mountDir) returns every
// environment variable that actually activates instrumentation once the
// volume is populated. label and mechanism are just for the instructions
// text.
const OTEL_LANGUAGES = {
  java: {
    label: 'Java',
    mechanism: 'a JVM -javaagent — the standard OpenTelemetry Java auto-instrumentation, one jar, nothing else needed.',
    fetchServices: [
      {
        suffix: null,
        image: 'curlimages/curl:8.10.1',
        script: (mountDir) =>
          `test -f ${mountDir}/opentelemetry-javaagent.jar || curl -fL -o ${mountDir}/opentelemetry-javaagent.jar https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar`,
        // curlimages/curl runs as a non-root user by default (its own
        // security default) — but a freshly created Docker volume is owned
        // by root, so without this it fails writing the file (curl exit
        // 23, "Failed writing received data to disk"). Safe here
        // specifically because this container does nothing but run one
        // command against its own dedicated, otherwise-empty volume, then
        // exits for good.
        user: '0:0',
      },
    ],
    env: (mountDir) => ({
      JAVA_TOOL_OPTIONS: `-javaagent:${mountDir}/opentelemetry-javaagent.jar`,
    }),
  },
  node: {
    label: 'Node.js',
    mechanism:
      'the OpenTelemetry Injector (LD_PRELOAD) plus the official @opentelemetry/auto-instrumentations-node package — same zero-source-code-change result as Java, via a different OS-level mechanism since Node has no single-file agent equivalent.',
    fetchServices: [
      {
        suffix: null,
        // node:22-alpine, not curlimages/curl: this fetch step needs npm
        // itself (to install the real instrumentation package), and
        // Alpine's busybox ships wget for free, so nothing extra needs
        // installing just to fetch the injector binary either.
        image: 'node:22-alpine',
        // Detects CPU architecture at fetch time (the fetch service runs
        // on the same Docker host as the target service, so this always
        // matches) — release assets are published per-arch
        // (libotelinject_amd64.so / libotelinject_arm64.so), there's no
        // universal binary. The injector .so itself is static-pie linked
        // (verified: no dynamic libc dependency), so one build works
        // whether the target container's own base image is glibc or
        // musl-based — only the CPU architecture matters here.
        script: (mountDir) =>
          [
            'set -e',
            // $$ (not $) everywhere below a shell variable is READ, not
            // assigned: Docker Compose does its own ${VAR}/$VAR
            // interpolation over the WHOLE compose file before any
            // container runs, so an unescaped "$ARCH" here gets replaced
            // by Compose itself (with an empty string, since nothing sets
            // an ARCH env var on the host) before the container's shell
            // ever sees it — confirmed exactly this way against a real
            // `docker compose config`/`up`: the case statement silently
            // got `case "" in` instead of the actual architecture, so the
            // fetch hit the "unsupported CPU architecture" branch with a
            // BLANK name. "$$ARCH" survives Compose's pass as a literal
            // "$ARCH" and only THEN reaches the container's shell, which
            // is what was always intended.
            'ARCH=$(uname -m)',
            'case "$$ARCH" in x86_64) OTEL_ARCH=amd64 ;; aarch64|arm64) OTEL_ARCH=arm64 ;; ' +
              '*) echo "podotype: unsupported CPU architecture $$ARCH for the Node OTel injector" >&2; exit 1 ;; esac',
            `test -f ${mountDir}/libotelinject.so || wget -qO ${mountDir}/libotelinject.so ` +
              `"${OTEL_INJECTOR_BASE_URL}/${OTEL_INJECTOR_VERSION}/libotelinject_$$OTEL_ARCH.so"`,
            `test -d ${mountDir}/node_modules/@opentelemetry/auto-instrumentations-node || ` +
              `npm install --prefix ${mountDir} @opentelemetry/auto-instrumentations-node@${OTEL_AUTO_INSTRUMENTATIONS_NODE_VERSION} ` +
              '--no-save --no-audit --no-fund --loglevel=error',
          ].join('; '),
        // node:22-alpine's default user is already root, unlike
        // curlimages/curl — no override needed to write into a freshly
        // created (root-owned) volume.
        user: null,
      },
    ],
    env: (mountDir) => ({
      LD_PRELOAD: `${mountDir}/libotelinject.so`,
      NODEJS_AUTO_INSTRUMENTATION_AGENT_PATH: `${mountDir}/node_modules/@opentelemetry/auto-instrumentations-node/build/src/register.js`,
    }),
  },
  python: {
    label: 'Python',
    mechanism:
      'the OpenTelemetry Injector (LD_PRELOAD), which prepends a prebuilt Python package bundle to PYTHONPATH — same zero-source-code-change result as Java/Node, but see the caution below before using this one.',
    // Genuinely riskier than Java/Node — surfaced up front in the generated
    // instructions (extraCaution), not just in this code comment.
    extraCaution:
      'Python is the one language here the OpenTelemetry Injector project itself warns about: "it is not always safe to inject the additional Python packages due to possible dependency conflicts." ' +
      'Concretely — this bundle brings its own protobuf, grpcio, urllib3, and requests, and because PYTHONPATH puts it first, those versions can shadow ones your app already depends on directly, ' +
      'not just the tracing bits. That is a different failure mode than Java or Node here: a bad interaction can break your app itself, not just tracing. ' +
      'Test this on a non-production copy of the service first. If anything looks wrong after applying it, removing the -f flag for this file (or unsetting LD_PRELOAD) reverts it immediately, no rebuild needed.',
    fetchServices: [
      {
        suffix: 'glibc',
        // Debian-based (glibc) — matches most non-Alpine Python images
        // (python:3.x-slim, python:3.x-bookworm, etc.). Also fetches the
        // shared injector .so, piggybacked here so it's only downloaded
        // once — same static-pie binary either fetch container could grab,
        // it doesn't depend on this container's own libc, only its CPU
        // architecture.
        image: 'python:3.12-slim',
        script: (mountDir) => [pythonInjectorSoFetchScript(mountDir), pythonBundleFetchScript(`${mountDir}/python/glibc`)].join('; '),
        user: null,
      },
      {
        suffix: 'musl',
        // Alpine (musl) — matches python:3.x-alpine images. Built in a
        // separate, musl-native container rather than cross-compiled: pip
        // resolves musllinux-tagged wheels correctly this way, the same
        // reason the injector's own docs ship separate glibc/musl trees
        // instead of one universal bundle.
        image: 'python:3.12-alpine',
        script: (mountDir) => pythonBundleFetchScript(`${mountDir}/python/musl`),
        user: null,
      },
    ],
    // The injector auto-detects which of PYTHON_AUTO_INSTRUMENTATION_AGENT_PATH_PREFIX's
    // glibc/ or musl/ subdirectories matches the target process's actual
    // libc and prepends only that one to PYTHONPATH — same prefix value
    // works regardless of which the target container turns out to be.
    env: (mountDir) => ({
      LD_PRELOAD: `${mountDir}/libotelinject.so`,
      PYTHON_AUTO_INSTRUMENTATION_AGENT_PATH_PREFIX: `${mountDir}/python`,
    }),
  },
  dotnet: {
    label: '.NET',
    mechanism:
      'the OpenTelemetry Injector (LD_PRELOAD) again — same mechanism as Node/Python, but for .NET it works by setting CoreCLR\'s own native profiler env vars (CORECLR_PROFILER_PATH etc.) once loaded into the target process, pointing at the official OpenTelemetry .NET Automatic Instrumentation release.',
    extraCaution:
      'New here: unlike Java/Node/Python (each verified end-to-end against a real running service before being trusted in this project), .NET support hasn\'t been run against a real .NET service yet — the fetch script and env vars below follow the injector\'s and the .NET auto-instrumentation project\'s own documented contract, but please treat the first run as a real test, not a known-good path. ' +
      'Also requires .NET 8 or later in the target container (older frameworks aren\'t supported by the upstream agent) — if nothing shows up, check that first.',
    fetchServices: [
      {
        suffix: null,
        // Just needs curl/wget + unzip — unlike Python, the fetch step
        // itself doesn't need to run under a matching libc, because nothing
        // gets compiled/resolved here: the .NET project already publishes
        // separate prebuilt glibc/musl archives, so this one container just
        // downloads and unzips both into the layout the injector expects
        // (PREFIX/glibc/linux-<arch>/... and PREFIX/musl/linux-musl-<arch>/...).
        image: 'alpine:3.20',
        script: (mountDir) =>
          [
            'set -e',
            'apk add --no-cache unzip >/dev/null',
            // $$ throughout below, not $ — see the Node fetch script's own
            // comment above for exactly why (Docker Compose's own variable
            // interpolation silently eats an unescaped "$VAR" before the
            // container's shell ever runs).
            'ARCH=$(uname -m)',
            'case "$$ARCH" in x86_64) OTEL_ARCH=amd64; DOTNET_ARCH=x64 ;; aarch64|arm64) OTEL_ARCH=arm64; DOTNET_ARCH=arm64 ;; ' +
              '*) echo "podotype: unsupported CPU architecture $$ARCH for the .NET OTel injector" >&2; exit 1 ;; esac',
            `test -f ${mountDir}/libotelinject.so || wget -qO ${mountDir}/libotelinject.so ` +
              `"${OTEL_INJECTOR_BASE_URL}/${OTEL_INJECTOR_VERSION}/libotelinject_$$OTEL_ARCH.so"`,
            `test -d ${mountDir}/dotnet/glibc/linux-$$DOTNET_ARCH || (wget -qO /tmp/dotnet-glibc.zip ` +
              `"${OTEL_DOTNET_INSTRUMENTATION_BASE_URL}/${OTEL_DOTNET_INSTRUMENTATION_VERSION}/opentelemetry-dotnet-instrumentation-linux-glibc-$$DOTNET_ARCH.zip" ` +
              `&& mkdir -p ${mountDir}/dotnet/glibc/linux-$$DOTNET_ARCH ` +
              `&& unzip -q -o /tmp/dotnet-glibc.zip -d ${mountDir}/dotnet/glibc/linux-$$DOTNET_ARCH && rm -f /tmp/dotnet-glibc.zip)`,
            `test -d ${mountDir}/dotnet/musl/linux-musl-$$DOTNET_ARCH || (wget -qO /tmp/dotnet-musl.zip ` +
              `"${OTEL_DOTNET_INSTRUMENTATION_BASE_URL}/${OTEL_DOTNET_INSTRUMENTATION_VERSION}/opentelemetry-dotnet-instrumentation-linux-musl-$$DOTNET_ARCH.zip" ` +
              `&& mkdir -p ${mountDir}/dotnet/musl/linux-musl-$$DOTNET_ARCH ` +
              `&& unzip -q -o /tmp/dotnet-musl.zip -d ${mountDir}/dotnet/musl/linux-musl-$$DOTNET_ARCH && rm -f /tmp/dotnet-musl.zip)`,
          ].join('; '),
        user: null,
      },
    ],
    env: (mountDir) => ({
      LD_PRELOAD: `${mountDir}/libotelinject.so`,
      DOTNET_AUTO_INSTRUMENTATION_AGENT_PATH_PREFIX: `${mountDir}/dotnet`,
    }),
  },
  ruby: {
    label: 'Ruby',
    mechanism:
      'the OpenTelemetry Injector (LD_PRELOAD), which sets RUBYOPT to require the official "opentelemetry-auto-instrumentation" gem from a prebuilt gem bundle — same zero-source-code-change idea as Node/Python.',
    extraCaution:
      'The gem this relies on ("opentelemetry-auto-instrumentation") is brand new — version 0.1.0, first published in September 2026 — so treat this as the least battle-tested language here, more so even than the newness caveat above for .NET. ' +
      'It also requires Ruby 3.3 or later in the target container. Test on a non-production copy first, same advice as Python above, for the same reason: a bad interaction here could affect more than just tracing.',
    fetchServices: [
      {
        suffix: 'glibc',
        // Debian-based, matches ruby:3.x-slim / ruby:3.x-bookworm images.
        // Split by libc for the same reason Python is: some of this gem's
        // own dependencies (the opentelemetry-instrumentation-* family) may
        // pull in native extensions that get compiled against whichever
        // libc `gem install` runs under.
        image: 'ruby:3.3-slim',
        script: (mountDir) =>
          `test -d ${mountDir}/ruby/glibc/gems || gem install opentelemetry-auto-instrumentation ` +
          `-v ${OTEL_RUBY_AUTO_INSTRUMENTATION_VERSION} --install-dir ${mountDir}/ruby/glibc --no-document`,
        user: null,
      },
      {
        suffix: 'musl',
        image: 'ruby:3.3-alpine',
        script: (mountDir) =>
          `test -d ${mountDir}/ruby/musl/gems || gem install opentelemetry-auto-instrumentation ` +
          `-v ${OTEL_RUBY_AUTO_INSTRUMENTATION_VERSION} --install-dir ${mountDir}/ruby/musl --no-document`,
        user: null,
      },
    ],
    // Deliberately NOT setting RUBYOPT or OTEL_RUBY_ADDITIONAL_GEM_PATH
    // ourselves — the injector's own docs describe those two as "a coupled
    // pair" it manages together once it finds a valid gem home at this
    // prefix; setting either one here risks fighting the injector's own
    // logic instead of leaving it in charge.
    env: (mountDir) => ({
      LD_PRELOAD: `${mountDir}/libotelinject.so`,
      RUBY_AUTO_INSTRUMENTATION_AGENT_PATH_PREFIX: `${mountDir}/ruby`,
    }),
  },
  php: {
    label: 'PHP',
    mechanism:
      "the official OpenTelemetry PECL extension (ext-opentelemetry) plus the PHP SDK's own zero-code distro, loaded via an extra php.ini scan directory (PHP_INI_SCAN_DIR) — not the OpenTelemetry Injector the other four languages here use. PHP has no LD_PRELOAD-compatible story: ext-opentelemetry is a native extension that must match the target's EXACT PHP version, Zend Module API, thread-safety mode and CPU architecture, so podotype builds it against that one service's own container image (see 'image' below) instead of a generic fetch image like the others get.",
    extraCaution:
      "PHP is structurally different from every other language here, and the least proven: Java/Node/Python/.NET/Ruby all use one version-agnostic injector binary; PHP's own OTel integration genuinely requires a native extension compiled for that exact PHP build. podotype handles the matching by running the install step against this service's own image, but that step needs outbound network access AND, inside most minimal/production PHP images, no C compiler — if install-php-extensions (github.com/mlocati/docker-php-extension-installer, which podotype fetches and runs) can't find a prebuilt binary for this exact PHP version/architecture, the extension silently fails to install and this service gets no extension and no traces. Check `docker compose logs <service>-podotype-otel-fetch` first if nothing shows up. Also unverified: whether this project's OTLP/HTTP JSON ingestion (see server.js's OTLP ingestion comment) is actually honored by PHP's own OTLP exporter the way OTEL_EXPORTER_OTLP_PROTOCOL=http/json works for the other four — treat this as a real first test, same caution as .NET/Ruby above. Requires PHP 8.1+, and your service's entrypoint must not already set its own PHP_INI_SCAN_DIR (this appends to it with a leading ':', so the default scan dir still loads too) or override it after this env block takes effect.",
    fetchServices: [
      {
        suffix: null,
        // Dynamic, unlike every other language's fixed fetch image: has to
        // be THIS service's own image so the extension-installer resolves
        // (and, when no prebuilt binary matches, compiles) a binary that
        // actually matches this service's PHP version/API/TS/arch — a
        // generic php:8.x image here would silently build an extension
        // that may not load in a different PHP build at all.
        image: (entry) => entry.image,
        script: (mountDir) =>
          [
            'set -e',
            // install-php-extensions needs a compiler toolchain as a last
            // resort (most minimal images lack one; it still tries its own
            // prebuilt binaries first) — skip failures from that silently
            // rather than erroring the whole fetch, since a missing
            // compiler just means "no prebuilt binary available", which is
            // the known, called-out risk above, not a bug to crash on.
            'if command -v curl >/dev/null 2>&1; then ' +
              'curl -fsSL -o /tmp/install-php-extensions https://github.com/mlocati/docker-php-extension-installer/releases/latest/download/install-php-extensions; ' +
              'elif command -v wget >/dev/null 2>&1; then ' +
              'wget -qO /tmp/install-php-extensions https://github.com/mlocati/docker-php-extension-installer/releases/latest/download/install-php-extensions; ' +
              'else ' +
              'php -r "copy(\'https://github.com/mlocati/docker-php-extension-installer/releases/latest/download/install-php-extensions\', \'/tmp/install-php-extensions\');"; ' +
              'fi',
            'chmod +x /tmp/install-php-extensions',
            // FIX — confirmed live: Composer's require step later in this
            // script failed with exit 1 ("The zip extension and unzip/7z
            // commands are both missing, skipping" -> RuntimeException) on a
            // minimal php:*-cli image that has neither. install-php-extensions
            // can install the `zip` PHP extension itself (same tool already
            // used for `opentelemetry` here), which gives Composer what it
            // needs to extract downloaded packages without requiring a
            // separate unzip/7z binary or apt/apk package install.
            '/tmp/install-php-extensions opentelemetry zip',
            `mkdir -p ${mountDir}`,
            // Copy from wherever this PHP build's own extension_dir says,
            // not a hardcoded path — that differs by distro/version.
            `cp "$(php -r 'echo ini_get("extension_dir");')/opentelemetry.so" ${mountDir}/opentelemetry.so`,
            // Composer packages go in their OWN directory inside the
            // volume, never the app's own vendor/ — same "isolated bundle,
            // never touches the app's own dependency tree" rule Python's
            // --target install and Node's injector-owned node_modules
            // already follow above.
            'if command -v composer >/dev/null 2>&1; then COMPOSER_BIN=composer; ' +
              `else curl -fsSL https://getcomposer.org/composer.phar -o /tmp/composer.phar && chmod +x /tmp/composer.phar && COMPOSER_BIN="php /tmp/composer.phar"; fi`,
            // Curated bundle, same "modest, no-ops safely if the target
            // lib isn't installed" reasoning as Python's packages above:
            // the SDK/exporter plus the handful of PHP frameworks/HTTP
            // clients most self-hosted PHP services actually run. $$ (not
            // $) — see the Node fetch script's own comment above for why
            // an unescaped "$COMPOSER_BIN" here would get silently emptied
            // out by Compose's own variable interpolation before this
            // script ever runs.
            `$$COMPOSER_BIN require --working-dir=${mountDir} --no-interaction --quiet ` +
              'open-telemetry/sdk open-telemetry/exporter-otlp ' +
              'open-telemetry/opentelemetry-auto-laravel open-telemetry/opentelemetry-auto-symfony ' +
              'open-telemetry/opentelemetry-auto-slim open-telemetry/opentelemetry-auto-psr15 ' +
              'open-telemetry/opentelemetry-auto-psr18 open-telemetry/opentelemetry-auto-guzzle',
            // auto_prepend_file (not the app's own vendor/autoload.php,
            // which podotype has no reliable path to) is what actually
            // boots the SDK — this one line is the whole bootstrap.
            `echo '<?php require "${mountDir}/vendor/autoload.php";' > ${mountDir}/bootstrap.php`,
            // One ini file sets both the extension load and the
            // auto-prepend in one place, dropped into the scan dir this
            // service's PHP_INI_SCAN_DIR env (below) points at.
            `printf 'extension=%s/opentelemetry.so\\nauto_prepend_file=%s/bootstrap.php\\n' ${mountDir} ${mountDir} > ${mountDir}/otel.ini`,
          ].join('; '),
        user: null,
      },
    ],
    env: (mountDir) => ({
      // Leading ":" appends this dir to the image's own default scan dir
      // (usually /usr/local/etc/php/conf.d on official php images) instead
      // of replacing it — see extraCaution above for the one way this can
      // silently not apply.
      PHP_INI_SCAN_DIR: `:${mountDir}`,
      OTEL_PHP_AUTOLOAD_ENABLED: 'true',
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_PROPAGATORS: 'tracecontext,baggage',
    }),
  },
};

// ---- Guessing a service's language, so setup doesn't start from a blank
// dropdown ---------------------------------------------------------------
//
// This is a GUESS, never applied automatically — it only pre-fills the
// language choice in the UI (both the single-service "Set up" prompt and
// the bulk setup panel), which the person still confirms or overrides. That
// matters after the hono-command-router lesson: it turned out to be
// eclipse/hono-service-command-router (a Java/Vert.x service, unrelated to
// the "Hono" JS framework of the same name) mis-set to "node" — a wrong
// guess applied silently would have produced the exact same kind of
// quiet, no-error failure. Surfacing the guess with its reasoning, and
// requiring a human to accept it, is the honest way to make this useful
// without repeating that mistake.
//
// Uses only data Docker already tracks for every container — Config.Cmd /
// Entrypoint (the literal command it runs) and Config.Env (base images like
// node:18, python:3.12, openjdk:17 bake in telltale vars like NODE_VERSION,
// PYTHON_VERSION, JAVA_HOME) — via a single GET to the Engine API's own
// inspect endpoint. No exec into the container, no new access beyond the
// same read-only docker.sock this project already uses for discovery.
//
// Order matters: environment markers first (set by the base image at build
// time, so they're a strong signal even if the actual entrypoint is a
// wrapper shell script), then the command line itself, then a few common
// process-manager names that imply a language without naming it.
const LANGUAGE_GUESS_RULES = [
  { language: 'java', envPattern: /^(JAVA_HOME|JAVA_VERSION|JDK_VERSION)=/i, reason: (m) => `image sets ${m}` },
  { language: 'node', envPattern: /^(NODE_VERSION|NODE_ENV)=/i, reason: (m) => `image sets ${m}` },
  { language: 'python', envPattern: /^(PYTHON_VERSION|PYTHONUNBUFFERED)=/i, reason: (m) => `image sets ${m}` },
  // Recognized but not (yet) supported by podotype's own OTEL_LANGUAGES —
  // still worth reporting by name instead of just "unknown", so the UI can
  // say "detected: go — not supported yet" rather than leaving someone to
  // discover that the hard way, the way hono-command-router did for node.
  { language: 'dotnet', envPattern: /^(DOTNET_VERSION|ASPNETCORE_)/i, reason: (m) => `image sets ${m}` },
  { language: 'ruby', envPattern: /^(RUBY_VERSION|BUNDLE_)/i, reason: (m) => `image sets ${m}` },
  { language: 'go', envPattern: /^(GOLANG_VERSION|GOPATH)=/i, reason: (m) => `image sets ${m}` },
  { language: 'php', envPattern: /^(PHP_VERSION|PHP_INI_DIR)=/i, reason: (m) => `image sets ${m}` },
];

// Command-line executable name -> guessed language, checked against the
// first token of Cmd/Entrypoint (after stripping a leading shell wrapper
// like "sh -c" or "/bin/sh -c", which podotype's own generated fetch
// scripts also use, and plenty of real Docker images do too).
const LANGUAGE_GUESS_CMD_TOKENS = [
  { re: /^java$/, language: 'java' },
  { re: /^node(js)?$/, language: 'node' },
  { re: /^(python3?|gunicorn|uvicorn|celery)$/, language: 'python' },
  { re: /^bun$/, language: 'bun' }, // Hono-the-JS-framework's other common runtime — recognized, not supported
  { re: /^deno$/, language: 'deno' },
  { re: /^dotnet$/, language: 'dotnet' },
  { re: /^(ruby|bundle)$/, language: 'ruby' },
  { re: /^php(-fpm|-cgi)?\d*$/, language: 'php' },
];

// dotnet and ruby are now real OTEL_LANGUAGES entries (see above), so this
// set is normally empty — kept around as the place to list any FUTURE
// language the upstream OpenTelemetry Injector supports before podotype has
// templated it, so a guess can say "detected: X — not built yet" instead of
// just "unknown", the way this helped explain hono-command-router's
// misconfiguration before dotnet/ruby existed here.
const INJECTOR_SUPPORTED_NOT_YET_BUILT = new Set([]);

function guessLanguageFromInspect(inspect) {
  const env = (inspect && inspect.Config && inspect.Config.Env) || [];
  for (const rule of LANGUAGE_GUESS_RULES) {
    const match = env.find((e) => rule.envPattern.test(e));
    if (match) {
      return finalizeGuess(rule.language, rule.reason(match.split('=')[0]));
    }
  }

  const cmdParts = [
    ...((inspect && inspect.Config && inspect.Config.Entrypoint) || []),
    ...((inspect && inspect.Config && inspect.Config.Cmd) || []),
  ].map((s) => String(s));
  // Strip a leading shell wrapper ("sh", "-c") so the real interpreter name
  // (next non-flag token) is what gets matched.
  const meaningful = cmdParts.filter((p) => p && !/^(sh|bash|-c)$/.test(path.basename(p)) && !p.startsWith('-'));
  for (const token of meaningful) {
    const base = path.basename(token);
    const hit = LANGUAGE_GUESS_CMD_TOKENS.find((t) => t.re.test(base));
    if (hit) return finalizeGuess(hit.language, `entrypoint runs "${base}"`);
  }

  const image = (inspect && inspect.Config && inspect.Config.Image) || '';
  const imageHit = /python/i.test(image)
    ? 'python'
    : /node/i.test(image)
    ? 'node'
    : /(openjdk|java|jdk|jre)/i.test(image)
    ? 'java'
    : /php/i.test(image)
    ? 'php'
    : null;
  if (imageHit) return finalizeGuess(imageHit, `image name mentions "${imageHit}"`, /* lowConfidence */ true);

  return { guess: null, supported: false, reason: "couldn't tell from the container's own command or environment" };
}

function finalizeGuess(language, reason, lowConfidence) {
  const supported = Boolean(OTEL_LANGUAGES[language]);
  const notedUnsupported = !supported && INJECTOR_SUPPORTED_NOT_YET_BUILT.has(language);
  return {
    guess: language,
    supported,
    lowConfidence: Boolean(lowConfidence),
    reason,
    note: notedUnsupported
      ? `podotype doesn't have a ${language} template yet, though the underlying injector supports it`
      : !supported
      ? `${language} can't be auto-instrumented this way (compiled/unsupported runtime)`
      : null,
  };
}

// Shared by both Python fetch services (glibc and musl) — same package set,
// same pinned versions, just installed under a different --target and, by
// virtue of which base image runs it, resolved against a different libc's
// wheels. Deliberately a curated, modest bundle rather than every known
// instrumentor: opentelemetry-distro + the OTLP exporter (protocol/version
// match what Java and Node already send), plus requests/urllib3 (how most
// Python services call out to others) and Flask/FastAPI (the two most
// common Python web frameworks) — enough to get real client+server spans
// for a typical small-scale service without bundling instrumentors for
// frameworks that add real risk of their own (e.g. Django's instrumentor
// expects DJANGO_SETTINGS_MODULE to already be configured, which isn't
// something podotype can safely assume from outside the container).
// Instrumentors that don't find their target library installed are
// designed to no-op safely, not error — that's standard OTel Python
// behavior, not something podotype is relying on unverified.
//
// Versions pinned to what was actually installed and tested, not floated —
// same discipline as the injector binary and the Node package above.
const OTEL_PYTHON_PACKAGES = [
  'opentelemetry-distro==0.65b0',
  'opentelemetry-exporter-otlp==1.44.0',
  'opentelemetry-instrumentation-requests==0.65b0',
  'opentelemetry-instrumentation-urllib3==0.65b0',
  'opentelemetry-instrumentation-flask==0.65b0',
  'opentelemetry-instrumentation-fastapi==0.65b0',
  // Messaging/event-driven coverage — confirmed live: without this, a
  // kafka-python producer/consumer isn't patched at all, so no
  // traceparent gets injected into message headers on publish and no
  // span-link gets created on consume. This is what makes an async
  // Kafka hop show up as ONE continuous trace instead of two
  // disconnected ones (same OTel messaging semantic-convention
  // mechanism that keeps a synchronous HTTP hop's trace context intact
  // across a call, just over message headers instead of request
  // headers). Harmless no-op for python services that don't import
  // kafka-python at all.
  'opentelemetry-instrumentation-kafka-python==0.65b0',
];

// Downloads the shared injector .so using Python's own built-in urllib
// instead of curl/wget — python:3.12-slim (Debian) doesn't ship either by
// default, but every Python image obviously has python3, and urllib
// follows the GitHub release-asset redirect automatically. Arch-detected
// the same way as Node's fetch script, for the same reason (per-arch
// release assets, no universal binary).
//
// The python -c argument is wrapped in shell SINGLE quotes deliberately,
// with double quotes used for every string literal inside the Python code
// itself — this whole shell one-liner later gets wrapped again in a YAML
// double-quoted scalar (see yamlDoubleQuote), and an initial version of
// this that used double quotes on both the shell wrapper AND the Python
// f-strings collided: the shell closed the "-c" argument early at the
// first unescaped inner ", silently truncating the python command (caught
// by actually running the generated script, not by reading it — it looked
// fine printed out, and even *ran* without a shell syntax error, it just
// downloaded nothing and fell through). Single-quoting the outer wrapper
// sidesteps that entirely, since the Python code below contains no single
// quotes to escape.
function pythonInjectorSoFetchScript(mountDir) {
  const pyDownload =
    'import platform,urllib.request,sys; ' +
    'arch={"x86_64":"amd64","aarch64":"arm64","arm64":"arm64"}.get(platform.machine()); ' +
    'sys.exit("podotype: unsupported CPU architecture " + platform.machine() + " for the Python OTel injector") if not arch else None; ' +
    `urllib.request.urlretrieve(f"${OTEL_INJECTOR_BASE_URL}/${OTEL_INJECTOR_VERSION}/libotelinject_{arch}.so", "${mountDir}/libotelinject.so")`;
  return `test -f ${mountDir}/libotelinject.so || python3 -c '${pyDownload}'`;
}

function pythonBundleFetchScript(targetDir) {
  return [
    'set -e',
    `test -d ${targetDir} || pip install --no-cache-dir --disable-pip-version-check --target=${targetDir} ${OTEL_PYTHON_PACKAGES.join(' ')}`,
    // The package that actually activates zero-code instrumentation on
    // startup is a sitecustomize.py — Python's site module auto-imports a
    // top-level module by that name from anywhere on PYTHONPATH — but pip
    // installs it nested inside the package tree, not at the bundle root.
    // Copying it up is what turns "these packages happen to be importable"
    // into "instrumentation actually turns on." Verified directly: without
    // this copy, LD_PRELOAD + the path prefix env var set PYTHONPATH
    // correctly but nothing instrumented anything.
    `test -f ${targetDir}/sitecustomize.py || cp ${targetDir}/opentelemetry/instrumentation/auto_instrumentation/sitecustomize.py ${targetDir}/sitecustomize.py`,
  ].join('; ');
}

// One single file, always this name, covering every currently-traced
// service at once — not one file per service. This project tried
// per-service files first (docker-compose.otel.<service>.yml) plus an
// include: block listing all of them, specifically to fix an earlier bug
// where every service shared one literal filename and instrumenting a
// second service silently told you to overwrite the first one's file.
// That worked, but created a worse problem once more than one service was
// in play: a per-service filename reads as "this file only affects that
// one service," which is backwards once the include: block quietly starts
// pulling in every OTHER currently-enabled service too — including ones
// that had since stopped being watched, or belonged to an unrelated
// project that merely happened to still be running under a name podotype
// once instrumented. There was no way to tell, from the filename or from
// looking at your own docker-compose.yml, that a stale entry was in there.
//
// This file is the fix: ONE file, regenerated from a live query every time
// it's fetched (see resolveOtelOverrideEntries below) — not additive, not
// something that accumulates. A service that's been disabled, or that
// you've stopped watching, or whose container isn't running anymore,
// simply isn't in the file the next time you fetch it. Nothing to
// manually prune. The tradeoff, called out explicitly in the generated
// instructions: since it's a full snapshot rather than a diff, you do need
// to re-fetch and re-save it whenever the traced set changes — an old
// saved copy on disk can still go stale, same as any generated file would.
const OTEL_OVERRIDE_FILENAME = 'docker-compose.podotype.yml';

// Renders a shell one-liner as a proper YAML double-quoted scalar. Without
// this, a plain (unquoted) scalar containing ": " (colon immediately
// followed by a space — e.g. an echo'd message like "podotype: unsupported
// ...") gets misread by YAML as a mapping key/value pair instead of literal
// text, silently corrupting the entrypoint command into something that
// isn't a string at all. Caught by actually parsing a generated Node
// override with a real YAML parser, not by eyeballing the output — Java's
// fetch script happened to contain no such colon, which is exactly how this
// stayed invisible.
function yamlDoubleQuote(str) {
  return '"' + str.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// entries: [{ containerName, composeServiceName, language }, ...] — every
// service that should be in the file, already resolved by
// resolveOtelOverrideEntries below (live-running, watched, otel-enabled).
// Builds ONE merged file covering all of them. Safe to combine multiple
// services in one services:/volumes: block because every name inside it
// (fetch services, volumes) is already namespaced by composeServiceName —
// same scoping the per-service-file design relied on, just no longer split
// across separate files.
async function generateOtelOverride(entries) {
  if (!entries || entries.length === 0) {
    const err = new Error('no services currently have tracing enabled and being watched — turn tracing on for a service first.');
    err.statusCode = 400;
    throw err;
  }

  const mountDir = '/otel';
  const serviceYamlBlocks = [];
  const volumeNames = [];
  const rosterLines = [];
  const usedLanguages = new Set();
  // Entries this fetch couldn't include, with why — see the dockerTagImage
  // failure case below. One service hitting a problem used to throw and
  // take down the WHOLE merged file (every other already-working
  // service's tracing setup along with it, since they all share one
  // request) — now it just drops that one service out, with a reason, and
  // everyone else's still comes back.
  const skippedLines = [];

  for (const { containerName, composeServiceName, language, image } of entries) {
    const lang = OTEL_LANGUAGES[language];
    if (!lang) {
      const supported = Object.keys(OTEL_LANGUAGES).join(', ') || '(none yet)';
      throw new Error(`unsupported language "${language}" for "${containerName}" — supported: ${supported}`);
    }

    const fetchServiceNames = lang.fetchServices.map(
      (fs) => `${composeServiceName}-podotype-otel-fetch${fs.suffix ? `-${fs.suffix}` : ''}`
    );
    const volumeName = `${composeServiceName}-otel-agent`;

    // Resolve every fetch image for THIS entry (tagging the local image if
    // needed — see below) before committing any of it to the shared
    // output arrays, so a failure can `continue` past just this one
    // service without having already pushed a half-finished block for it.
    const resolvedFetchImages = [];
    let entryFailed = false;
    for (const fs of lang.fetchServices) {
      // Most languages hardcode this fetch image; PHP's is a function of
      // this one entry's own container image instead (see its
      // OTEL_LANGUAGES entry above for why).
      let fetchImage = typeof fs.image === 'function' ? fs.image({ containerName, composeServiceName, language, image }) : fs.image;
      if (!fetchImage) {
        skippedLines.push(
          `#   - ${containerName} (compose service "${composeServiceName}", ${lang.label}) — SKIPPED: couldn't determine its own container image (needed to match its exact PHP build) — wait for the next discovery poll and try again`
        );
        entryFailed = true;
        break;
      }
      // Docker's container-list API reports `Image` as the repo:tag a
      // container was started with — UNLESS that tag has since been
      // retagged to point at a different image (e.g. a `--build` rebuild
      // of php-svc reassigns the "php-svc" tag to the new image, leaving
      // any still-running OLD php-svc container's Image field as the raw
      // image ID instead, since the tag no longer describes what it's
      // actually running). That ID comes through as "sha256:<64 hex>", and
      // Docker refuses BOTH forms that string as a Compose "image:" value:
      // written with the "sha256:" prefix, Compose parses it as repository
      // "sha256", tag "<hex>" and tries to PULL that nonexistent repo
      // ("pull access denied for sha256, repository does not exist");
      // written bare, Docker's reference grammar outright rejects a name
      // that's exactly 64 hex characters, reserved so it's never ambiguous
      // with a digest ("invalid repository name ..., cannot specify
      // 64-byte hexadecimal strings") — confirmed hitting both of these in
      // practice. The only thing that reliably works is giving the image a
      // real repo:tag of its own — this engine's one deliberate write
      // against the Docker socket (see dockerTagImage's own comment) — and
      // handing Compose THAT instead of the raw ID.
      const bareId = fetchImage.startsWith('sha256:') ? fetchImage.slice('sha256:'.length) : fetchImage;
      let pulledLocalTag = false;
      if (/^[0-9a-f]{64}$/i.test(bareId)) {
        const repo = `podotype-otel-src-${composeServiceName}`;
        const tag = 'latest';
        try {
          await dockerTagImage(bareId, repo, tag);
        } catch (err) {
          skippedLines.push(
            `#   - ${containerName} (compose service "${composeServiceName}", ${lang.label}) — SKIPPED: couldn't tag its ` +
              `container image (${bareId.slice(0, 12)}) for Code Tracing — ${err.message}. If that image was removed ` +
              `(e.g. a rebuild since the last discovery poll), wait for the next poll and try again.`
          );
          entryFailed = true;
          break;
        }
        fetchImage = `${repo}:${tag}`;
        pulledLocalTag = true;
      }
      resolvedFetchImages.push({ fetchImage, pulledLocalTag });
    }
    if (entryFailed) continue;

    usedLanguages.add(language);
    rosterLines.push(`#   - ${containerName} (compose service "${composeServiceName}", ${lang.label})`);
    volumeNames.push(volumeName);

    for (let i = 0; i < lang.fetchServices.length; i++) {
      const fs = lang.fetchServices[i];
      const { fetchImage, pulledLocalTag } = resolvedFetchImages[i];
      serviceYamlBlocks.push(
        `  ${fetchServiceNames[i]}:`,
        `    image: ${fetchImage}`,
        // Only for the just-tagged, podotype-owned local image — the
        // other, hardcoded fetch images (ruby:3.3-slim, python:3.12-slim,
        // etc.) are real public images and should still pull/update
        // normally. Belt-and-suspenders: the tag above already points at
        // something local, but this rules out Compose trying a registry
        // pull for it under any circumstance.
        ...(pulledLocalTag ? ['    pull_policy: "never"'] : []),
        '    restart: "no"',
        ...(fs.user ? [`    user: "${fs.user}"`] : []),
        '    volumes:',
        `      - ${volumeName}:${mountDir}`,
        '    entrypoint:',
        '      - sh',
        '      - -c',
        // Each fetch script already skips the network step on every
        // subsequent `up` once the volume has what it needs — only the
        // very first run actually hits the network. Double-quoted (see
        // yamlDoubleQuote) so a colon-space anywhere in the script (Node's
        // and Python's error messages both have one) can never be
        // misparsed as a YAML mapping.
        `      - ${yamlDoubleQuote(fs.script(mountDir))}`,
        ''
      );
    }

    serviceYamlBlocks.push(
      `  ${composeServiceName}:`,
      '    depends_on:',
      ...fetchServiceNames.flatMap((n) => [`      ${n}:`, '        condition: service_completed_successfully']),
      '    environment:',
      ...Object.entries(lang.env(mountDir)).map(([key, value]) => `      ${key}: "${value}"`),
      `      OTEL_SERVICE_NAME: "${containerName}"`,
      // SAAS-CLICKHOUSE BRANCH: port 4318 + http/json, not 4317 + grpc —
      // `app` itself now receives OTLP directly (see startOtlpIngestServer)
      // and only implements OTLP/HTTP with JSON bodies, not gRPC/protobuf
      // (see that function's comment for why: no protobuf codec otherwise
      // needed anywhere in this project). All three languages here
      // (Java's agent, Python's opentelemetry-exporter-otlp bundle, Node's
      // auto-instrumentations-node) are standard OTel SDKs/agents that
      // support http/json via this same env var per their own docs — but
      // unlike the Beyla path (confirmed against Beyla's own docs and
      // exercised in this project), this specific combination — three
      // different languages' bundled exporters actually switching
      // correctly at runtime via this env var alone, with no bundle/package
      // changes — has NOT been run end-to-end from the environment this
      // branch was written in (see server.js's OTLP ingestion comment for
      // why). If a service using this opt-in path shows no traces after
      // deploying, this line is the first thing to check.
      '      OTEL_EXPORTER_OTLP_ENDPOINT: "http://host.docker.internal:4318"',
      // FIX #2 — confirmed live, second layer of the same bug: "http/json" is
      // NOT a value the OTel JAVA SDK's OTLP exporter recognizes for ANY
      // signal (traces included, not just metrics/logs) — only
      // "http/protobuf" and "grpc" are real OTLP protocol values per the
      // OTel spec; "http/json" is a non-standard extension only some SDKs
      // (apparently Node's) choose to tolerate. Disabling metrics/logs
      // above only moved the crash from `ConfigurationException:
      // Unsupported OTLP metrics protocol: http/json` to the identical
      // error on the TRACES exporter instead — Java's SDK rejects this
      // value everywhere, not just for metrics. agent's own OTLP ingest
      // server already branches on Content-Type and decodes protobuf
      // (decodeOtlpProtobufTraces — the same path Beyla's own traffic
      // already exercises, since Beyla always sends protobuf regardless of
      // its own configured protocol — see this file's/engine's comment on
      // that), so there is no cost to using the real, spec-correct value
      // here instead of the one that only happened to work for Node.
      '      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf"',
      // FIX — confirmed live (thin-agent dev stack, dummy-stack's java-svc):
      // the Java agent's own autoconfigure validates
      // OTEL_EXPORTER_OTLP_PROTOCOL strictly PER SIGNAL, and "http/json" is
      // not a value its OTLP *metrics* exporter accepts (only
      // "http/protobuf"/"grpc" are) — without this, the Java agent throws
      // `ConfigurationException: Unsupported OTLP metrics protocol:
      // http/json` while configuring its MeterProvider and the ENTIRE
      // agent fails to start, meaning zero traces too, not just metrics.
      // This is exactly the failure mode the comment above already warned
      // about ("has NOT been run end-to-end... if a service shows no
      // traces, this line is the first thing to check") — confirmed now.
      // This app's own startOtlpIngestServer only implements POST
      // /v1/traces anyway — there is nowhere for a metrics or logs export
      // to land even if it succeeded — so disabling both outright, for
      // every language, is strictly correct, not just a Java workaround.
      // Same fix Beyla's own config.yml already applies
      // (OTEL_METRICS_EXPORTER: "none") for exactly this reason.
      '      OTEL_METRICS_EXPORTER: "none"',
      '      OTEL_LOGS_EXPORTER: "none"',
      '    volumes:',
      `      - ${volumeName}:${mountDir}:ro`,
      '    extra_hosts:',
      // host.docker.internal resolves on Docker Desktop (Windows/Mac)
      // without this, but plain Linux Docker needs it spelled out
      // explicitly.
      '      - "host.docker.internal:host-gateway"',
      ''
    );
  }

  if (serviceYamlBlocks.length === 0) {
    const err = new Error(
      `none of the currently traced services could be included right now: ${skippedLines.map((l) => l.replace(/^#\s*-\s*/, '')).join('; ')}`
    );
    err.statusCode = 400;
    throw err;
  }

  const yaml = [
    `# Generated by podotype — ONE file covering every service currently traced:`,
    ...rosterLines,
    ...(skippedLines.length ? ['#', '# Skipped this time (see the warning returned alongside this file for why):', ...skippedLines] : []),
    '#',
    '# This file is a full snapshot, regenerated from scratch every time you fetch',
    "# it — not additive. Stop watching a service, or turn its tracing off, and it",
    "# simply won't be in the file the next time you re-fetch it — nothing to",
    '# manually remove here. Just remember to re-save this file over your old copy',
    "# when the traced set changes, since your saved copy on disk doesn't update",
    '# itself.',
    '#',
    '# Requires Docker Compose v2.20+ (current Docker Desktop has this).',
    '#',
    '# Apply alongside your existing compose file — this does NOT replace it. The',
    '# "docker-compose.yml" below is just an EXAMPLE filename — swap in whatever',
    '# your own main compose file is actually called (docker-compose.local.yml,',
    '# compose.yaml, etc.) — the important part is the "-f ... -f" pairing:',
    `#   docker compose -f docker-compose.yml -f ${OTEL_OVERRIDE_FILENAME} up -d`,
    '#',
    '# FIX — confirmed: this command was in the file\'s own header comments, but',
    '# the cleanup command (needed every time the traced set changes and old',
    '# fetch containers get left behind as Compose "orphans") previously only',
    '# lived in the separate dashboard instructions text, not in this saved',
    '# file — so anyone working from the saved .yml alone never saw it. Added',
    '# here too, right next to the apply command, so both travel together:',
    '#   docker ps -a --filter "name=-podotype-otel-fetch" --format "{{.Names}}" | xargs -r docker rm -f',
    '',
    'services:',
    ...serviceYamlBlocks,
    'volumes:',
    ...volumeNames.map((v) => `  ${v}: {}`),
    '',
  ].join('\n');

  const mechanismLines = [...usedLanguages].map((l) => `  - ${OTEL_LANGUAGES[l].label}: ${OTEL_LANGUAGES[l].mechanism}`);
  const cautionLines = [...usedLanguages]
    .filter((l) => OTEL_LANGUAGES[l].extraCaution)
    .map((l) => `⚠ ${OTEL_LANGUAGES[l].label}: ${OTEL_LANGUAGES[l].extraCaution}`);

  const instructions = [
    'This one file covers every service currently traced:',
    ...rosterLines.map((l) => l.replace(/^#/, '')),
    ...(skippedLines.length
      ? ['', 'Skipped this time (not in the file below — fix and re-fetch to include them):', ...skippedLines.map((l) => l.replace(/^#/, ''))]
      : []),
    '',
    'How each mechanism works:',
    ...mechanismLines,
    ...(cautionLines.length ? ['', ...cautionLines] : []),
    '',
    `1. Save the YAML above as ${OTEL_OVERRIDE_FILENAME}, next to your main compose file.`,
    `2. Apply it: docker compose -f docker-compose.yml -f ${OTEL_OVERRIDE_FILENAME} up -d`,
    '   "docker-compose.yml" here is just an EXAMPLE name — replace it with whatever your own main compose file is',
    '   actually called (e.g. docker-compose.local.yml). The only thing that matters is passing that real file as the',
    `   first "-f" and ${OTEL_OVERRIDE_FILENAME} as the second, so Compose merges them.`,
    '   (needs Docker Compose v2.20+ — current Docker Desktop has this)',
    'That command fetches everything needed automatically the first time — nothing to download by hand. Traces should',
    'start appearing in podotype within about a minute of real traffic hitting a traced service.',
    '',
    // FIX — moved up to sit right next to the apply command (it's the very
    // next thing you'd run after step 2, not an afterthought), AND the
    // name pattern itself now has "podotype" folded in (see
    // fetchServiceNames above) — not just this doc text — specifically so
    // this filter can't accidentally match some unrelated "*-otel-fetch*"
    // container a user's own stack happens to already have.
    '3. Clean up afterward: each traced service gets its own one-shot fetch container(s), named',
    '   "<service>-podotype-otel-fetch" (or "-podotype-otel-fetch-glibc"/"-podotype-otel-fetch-musl" for Python).',
    '   They exit right after they run and normally just sit there stopped — harmless, but re-applying this file',
    '   after the traced set changes can leave old ones behind as Compose "orphans." Do NOT use',
    '   "docker compose up --remove-orphans" to clear these if this compose project has other services in it — that',
    "   flag removes ANY container Compose doesn't recognize, including unrelated ones. Instead, remove only",
    "   podotype's own fetch containers by this exact, collision-safe name pattern:",
    '',
    '     docker ps -a --filter "name=-podotype-otel-fetch" --format "{{.Names}}" | xargs -r docker rm -f',
    '',
    '   That matches only containers with "-podotype-otel-fetch" in the name — nothing else in your stack, and',
    "   nothing that merely happens to contain the word \"otel\" or \"fetch\" on its own.",
    '',
    `IMPORTANT — this is a snapshot, not a diff: whenever you enable/disable tracing on a service, or stop/start`,
    `watching one, come back here and re-fetch this file, then overwrite your saved ${OTEL_OVERRIDE_FILENAME}. A`,
    "service that no longer belongs just stops appearing on the next fetch — there's nothing to manually delete, but",
    'an old saved copy on disk will keep including services that no longer qualify until you refresh it.',
    '',
    `Heads up if this is redeployed by CI/CD (Jenkins, GitHub Actions, etc.): the "-f" flag above only applies when`,
    `whatever "up" command recreates a container includes it. A pipeline that only knows about your original main`,
    'compose file will recreate these services without it — tracing goes quiet, silently, with no error.',
    'podotype deliberately can\'t fix this for you: it only ever reads the Docker API, it never creates, recreates,',
    'or modifies containers. Three ways to make it durable, best first:',
    '',
    '  a) Compose "include" (needs Compose v2.20+, check with `docker compose version`) — add this at the TOP of your',
    '     real main compose file (whatever it\'s actually named) that your pipeline deploys, then commit both files',
    '     to the repo it builds from:',
    '       include:',
    `         - ${OTEL_OVERRIDE_FILENAME}`,
    '     Once it\'s in place, a plain "docker compose up -d" — from anyone, from CI/CD, no -f flags — already',
    "     includes tracing, because it's part of the project just by existing in the repo. Since the filename never",
    '     changes, updating this file in place (when the traced set changes) is enough — the include: line itself',
    '     never needs to change.',
    '  b) No "include" support: copy the relevant service blocks above directly into their own blocks in your real',
    '     main compose file. Same effect, but stops being auto-regenerated — more manual upkeep from here on.',
    '  c) Longer-term: bake instrumentation into each service\'s own Dockerfile (fetch it in a build stage, set the',
    '     same environment variables as permanent ENV lines) so it ships with the image itself — no compose file needed.',
  ].join('\n');

  // The copy-pasteable half of option (a) above. Just one line now — the
  // filename never changes, so unlike the old per-service design this
  // never needs edits when the traced set changes, only the file's own
  // contents do.
  const includeSnippet = ['include:', `  - ${OTEL_OVERRIDE_FILENAME}`, ''].join('\n');

  // `warnings` is additive — existing callers that only read
  // filename/yaml/instructions/includeSnippet are unaffected; it's there
  // for a UI that wants to show "N service(s) skipped" as its own banner
  // instead of making someone read the full instructions text to notice.
  return {
    filename: OTEL_OVERRIDE_FILENAME,
    yaml,
    instructions,
    includeSnippet,
    warnings: skippedLines.map((l) => l.replace(/^#\s*-\s*/, '')),
  };
}

// ---- Active health checks (Kuma-style, manual override) --------------------
//
// Docker's own health status (see dockerHealthSignal above) is now the
// default up/down source for every service, for free. This still exists
// for the case that default doesn't cover: a service with no Docker
// HEALTHCHECK defined, where "container is running" isn't a good enough
// proxy for "actually serving traffic correctly" — same trade-off Uptime
// Kuma makes, kept as an explicit opt-in rather than something podotype
// asks for by default now that Docker health covers most cases for free.
//
// name -> { check: {type, target}, timer, result: {up, checkedAt, responseTimeMs, error} | null }
const activeChecks = new Map();

function stopCheck(name) {
  const existing = activeChecks.get(name);
  if (existing && existing.timer) clearInterval(existing.timer);
  activeChecks.delete(name);
}

function startCheck(name, check) {
  stopCheck(name);
  if (!check || !check.target) return;
  const entry = { check, result: null, timer: null };
  activeChecks.set(name, entry);
  const run = () => runCheckOnce(name);
  run(); // fire immediately — don't make the UI wait a full interval for a first result
  entry.timer = setInterval(run, CHECK_INTERVAL_SECONDS * 1000);
}

async function runCheckOnce(name) {
  const entry = activeChecks.get(name);
  if (!entry) return;
  const startedAt = Date.now();
  try {
    if (entry.check.type === 'tcp') {
      await tcpCheck(entry.check.target, CHECK_TIMEOUT_SECONDS * 1000);
    } else {
      await httpCheck(entry.check.target, CHECK_TIMEOUT_SECONDS * 1000);
    }
    entry.result = { up: true, checkedAt: Date.now(), responseTimeMs: Date.now() - startedAt, error: null };
  } catch (err) {
    entry.result = {
      up: false,
      checkedAt: Date.now(),
      responseTimeMs: Date.now() - startedAt,
      error: describeFetchError(err),
    };
  }
}

function httpCheck(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    fetch(url, { signal: controller.signal })
      .then((res) => {
        // Same definition Uptime Kuma uses by default: anything that isn't
        // a server error counts as "up" — a 404 still means something
        // answered the connection, which is the thing we're actually
        // trying to detect here.
        if (res.status >= 500) reject(new Error(`HTTP ${res.status}`));
        else resolve();
      })
      .catch(reject)
      .finally(() => clearTimeout(timer));
  });
}

function tcpCheck(target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lastColon = target.lastIndexOf(':');
    const host = lastColon === -1 ? target : target.slice(0, lastColon);
    const port = parseInt(lastColon === -1 ? '' : target.slice(lastColon + 1), 10);
    if (!host || !Number.isInteger(port)) {
      reject(new Error(`invalid tcp target "${target}", expected host:port`));
      return;
    }
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('connect timeout'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---- Express app -----------------------------------------------------------

const app = express();
app.use(express.json());

// ---- Static UI (self-hosted combined container only) ------------------
// The self-hosted product combines what used to be three containers
// (engine, web, beyla) into one — see docker-entrypoint.sh and
// deploy/docker-compose.yaml's `app` service. `web`'s old job (serve the
// compiled React dashboard — see apps/self-hosted/web/server.js, which
// this build no longer uses) is folded in here: the frontend is compiled
// and copied in as ./public at image build time (see this directory's
// Dockerfile), same as the single-container image did before the
// engine/web split. Purely additive and a no-op when ./public doesn't
// exist, so the hosted product's own `engine` image (which never copies
// a frontend build in) behaves exactly as before.
const STATIC_UI_DIR = path.join(__dirname, 'public');
if (fs.existsSync(STATIC_UI_DIR)) {
  app.use(
    express.static(STATIC_UI_DIR, {
      etag: false,
      lastModified: false,
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
    })
  );
}

// ---- Engine API auth ---------------------------------------------------
//
// This process no longer serves the React UI itself (see apps/self-hosted/web/server.js)
// — every request that reaches it is either the `web` service proxying on
// a real viewer's behalf, or, in a deployment where engine and web are
// genuinely on separate hosts/networks (the point of the split), some
// other caller that needs to prove it's allowed to ask. A single shared
// key rather than per-user accounts: there's still conceptually one caller
// of this API (the web service, acting for whoever's looking at the
// dashboard right now) — this is a network-boundary check, not
// multi-tenant auth, and it'll need to become real auth once "web" is
// actually a multi-tenant hosted router talking to many different
// people's engines.
//
// ENGINE_API_KEY comes from docker-compose.yml's PODOTYPE_ENGINE_API_KEY,
// shared by both the engine and web services — see that file's comment on
// why the baked-in default is fine for same-host/self-hosted use but
// should be changed for anything reachable beyond one trusted Docker
// network (same posture this project already takes with ClickHouse's own
// no-auth setup). If it's unset entirely (e.g. running server.js directly
// outside compose, during development), the check is skipped rather than
// locking you out.
const ENGINE_API_KEY = process.env.ENGINE_API_KEY || '';
function requireEngineKey(req, res, next) {
  if (!ENGINE_API_KEY) return next();
  const header = req.get('authorization') || '';
  const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (provided !== ENGINE_API_KEY) {
    return res.status(401).json({ error: 'missing or invalid engine API key' });
  }
  next();
}

// Self-hosted has no license server, no SaaS tiers, no billing, and no
// demo-trial expiry — all of that was removed for the public self-hosted
// repo (it was SaaS/hosted-only machinery to begin with; see the hosted
// product's own repo for that code). Self-hosted is simply free and
// unlimited: no watched-service cap, no retention clamp, no network call
// to anywhere.
app.use('/api', requireEngineKey);

// ---- tiny local state store --------------------------------------------
//
// Shape: { services: { "<name>": {
//   watched: bool,
//   check: {type, target} | null,      // manual Kuma-style override (opt-in)
//   metrics: {enabled: bool} | null,   // log-based request metrics (opt-in)
//   otel: {enabled: bool, language} | null, // full-tracing opt-in
//   logStorage: {enabled: bool} | null, // clustered log-pattern storage opt-in — see "Log pattern storage" above
// } }, alertConfig: { enabled, thresholds, sustainChecks, channels },
//   retention: { hours }, logRetention: { hours } }
// (No "beyla" field here — the eBPF watcher is always-on and un-selective
// now, see docker-compose.yml, so there's no per-service state to track.)
// alertConfig is the Alerts settings UI's backing store (GET/POST
// /api/alerts/config); retention is the trace Retention settings UI's
// (GET/POST /api/retention/config); logRetention is the SEPARATE log
// pattern retention setting (GET/POST /api/log-retention/config) — kept
// independent of trace retention on purpose, see
// CLICKHOUSE_LOG_PATTERN_TTL_HOURS's comment. See mergeAlertConfig/
// mergeRetentionConfig/mergeLogRetentionConfig below for why a saved
// state.json is merged field-by-field against each section's defaults
// rather than trusted as complete.

// Fills in anything defaultAlertConfig() has that a saved alertConfig
// doesn't — an older state.json saved before a field existed (e.g. this
// project adds a fifth trigger type later) would otherwise silently read as
// `undefined` for that field forever instead of picking up its default, the
// same class of bug the metrics/otel per-service migration below already
// guards against.
function mergeAlertConfig(saved) {
  const def = defaultAlertConfig();
  const ac = saved || {};
  return {
    enabled: { ...def.enabled, ...(ac.enabled || {}) },
    thresholds: { ...def.thresholds, ...(ac.thresholds || {}) },
    sustainChecks: typeof ac.sustainChecks === 'number' && ac.sustainChecks >= 1 ? ac.sustainChecks : def.sustainChecks,
    channels: {
      telegram: { ...def.channels.telegram, ...((ac.channels && ac.channels.telegram) || {}) },
      webhook: { ...def.channels.webhook, ...((ac.channels && ac.channels.webhook) || {}) },
    },
  };
}

// CLICKHOUSE_TRACE_TTL_HOURS is only the first-run seed (same pattern as
// the alert thresholds/channels above) — once retention.hours exists in
// state.json, changing it via POST /api/retention/config is what actually
// takes effect on future startups, not the env var.
function mergeRetentionConfig(saved) {
  const hours = saved && typeof saved.hours === 'number' && saved.hours >= 1 ? Math.round(saved.hours) : CLICKHOUSE_TRACE_TTL_HOURS;
  return { hours };
}

// Same shape/logic as mergeRetentionConfig, deliberately a separate
// function (and separate state.json key) rather than sharing one — trace
// retention and log-pattern retention are independent settings that
// happen to look identical today, not the same setting in two places; see
// CLICKHOUSE_LOG_PATTERN_TTL_HOURS's comment for why they default
// differently.
function mergeLogRetentionConfig(saved) {
  const hours =
    saved && typeof saved.hours === 'number' && saved.hours >= 1 ? Math.round(saved.hours) : CLICKHOUSE_LOG_PATTERN_TTL_HOURS;
  return { hours };
}

// The "Improve the cost panel" backlog item (#15): auto-estimating host
// cost from detected CPU/RAM (see UsageStats.jsx's VPS_COST_REFERENCE) is
// necessarily a rough guess — the same specs can be priced completely
// differently depending on the actual provider/instance type, which this
// app has no way to detect on its own (Coroot can show an exact price
// because it integrates with specific cloud providers' APIs; this
// doesn't). This is the escape hatch: a person who knows their real bill
// can enter it once and have that number shown instead of the estimate.
// null means "hasn't set one, use the auto-estimate" — same "absent means
// inherit the default" convention every other saved setting in this file
// uses.
function mergeCostOverride(saved) {
  if (!saved || typeof saved.monthlyUsd !== 'number' || !Number.isFinite(saved.monthlyUsd) || saved.monthlyUsd < 0) {
    return null;
  }
  return {
    monthlyUsd: saved.monthlyUsd,
    instanceLabel: typeof saved.instanceLabel === 'string' ? saved.instanceLabel.slice(0, 80) : null,
  };
}

function loadState() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {
      services: {},
      alertConfig: mergeAlertConfig(null),
      retention: mergeRetentionConfig(null),
      logRetention: mergeLogRetentionConfig(null),
      deployMarkers: [],
      alertHistory: [],
      costOverride: null,
    };
  }
  // Migrate the pre-health-check shape ({ watched: { name: bool } }) rather
  // than crash on a state.json left over from earlier testing.
  if (raw && raw.watched && !raw.services) {
    const services = {};
    for (const [name, watched] of Object.entries(raw.watched)) {
      services[name] = { watched: Boolean(watched), check: null, metrics: null, otel: null, logStorage: null };
    }
    return {
      services,
      alertConfig: mergeAlertConfig(raw.alertConfig),
      retention: mergeRetentionConfig(raw.retention),
      logRetention: mergeLogRetentionConfig(raw.logRetention),
      deployMarkers: Array.isArray(raw.deployMarkers) ? raw.deployMarkers : [],
      alertHistory: Array.isArray(raw.alertHistory) ? raw.alertHistory : [],
      costOverride: mergeCostOverride(raw.costOverride),
    };
  }
  const services = (raw && raw.services) || {};
  // Migrate the pre-metrics/otel shape ({ watched, check } only), and the
  // pre-logStorage shape, by filling in whichever new fields are absent
  // rather than requiring every entry to already have them.
  for (const entry of Object.values(services)) {
    if (!('metrics' in entry)) entry.metrics = null;
    if (!('otel' in entry)) entry.otel = null;
    if (!('logStorage' in entry)) entry.logStorage = null;
    // Per-service alert overrides — see "Per-service alert overrides"
    // section below. null means "use the global thresholds/enabled as-is,"
    // same as every service behaved before this existed.
    if (!('alertOverrides' in entry)) entry.alertOverrides = null;
  }
  return {
    services,
    alertConfig: mergeAlertConfig(raw && raw.alertConfig),
    retention: mergeRetentionConfig(raw && raw.retention),
    logRetention: mergeLogRetentionConfig(raw && raw.logRetention),
    // Absent on any state.json saved before deploy detection existed —
    // default to empty rather than crash, same pattern as the metrics/otel/
    // logStorage per-service migration just above.
    deployMarkers: Array.isArray(raw && raw.deployMarkers) ? raw.deployMarkers : [],
    // Same "absent on an older state.json -> default to empty" reasoning,
    // for the persisted mirror of the in-memory alertHistory array (see
    // pushAlertHistory) — this is what makes the Incidents page survive a
    // restart instead of going blank the moment the process recycles.
    alertHistory: Array.isArray(raw && raw.alertHistory) ? raw.alertHistory : [],
    // Manual cost override — see mergeCostOverride's own comment.
    costOverride: mergeCostOverride(raw && raw.costOverride),
  };
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getServiceEntry(state, name) {
  if (!state.services[name])
    state.services[name] = { watched: false, check: null, metrics: null, otel: null, logStorage: null, alertOverrides: null };
  return state.services[name];
}

// Start (or restart) every configured check for currently-watched services —
// called once at boot so checks survive a container restart.
function startConfiguredChecks() {
  const state = loadState();
  for (const [name, entry] of Object.entries(state.services)) {
    if (entry.watched && entry.check) startCheck(name, entry.check);
  }
}

// ---- ClickHouse queries (only relevant for services that opted into OTel) -

// Beyla names a span after its RUNTIME, not its container (see "Beyla name
// resolution" below) — so two containers running the same language (two
// Node services, this project's own app container being a Node process
// itself included) can end up sharing the exact same resource.service.name
// ("node"). Querying Tempo by that name alone then returns BOTH
// containers' spans mixed together — confirmed in production on this
// project's own box: a request to podotype's OWN dashboard API
// ("GET /api/services/*/traces", handled by the Node process this code is
// running in) showed up in the trace list for a watched service also
// named "node" by Beyla, because both are literally the same
// resource.service.name from Tempo's point of view. A per-container name
// map isn't enough to prevent this on its own — the map only decides what
// name to search BY, and that name can still be shared. The fix is to
// scope the actual query further, using the one thing that IS unique per
// process even when the name isn't: service.instance.id (host PID). See
// pollBeylaRedMetrics's beylaNameMapFromMetrics for where the actual
// instance ids belonging to one specific container get collected, and
// instanceIdsToTraceqlFilter just below for how that turns into an extra
// clause.
// BUG FIXED HERE, confirmed with real data before shipping (not another
// guess): ParentSpanId = '' used to be this clause's test for "this
// service's own inbound request." That's wrong — it actually means
// "nobody upstream propagated any trace context at all," which only
// describes Docker's own unconnected HEALTHCHECK curls. Every real
// request in a chain fails it, confirmed against Beyla's own
// trace_printer output (even the first hop of loadgen -> go -> java ->
// node -> python already carries a non-empty parentSpanId) AND against
// ClickHouse directly: 96,279 real `GET /work` rows existed the whole
// time, silently excluded by this clause on every service, which is why
// every dashboard showed nothing but health checks regardless of the
// "show health checks" toggle.
// Kind = 2 (OTLP's SERVER enum value) is the actual fix — confirmed
// against a live GROUP BY SpanName, Kind query rather than assumed: real
// data showed `processing`/`in queue` always at Kind=1 (INTERNAL, Beyla's
// own internal sub-spans — correctly excluded), and both `GET /work` and
// `GET /health` split cleanly across Kind=2 (SERVER — this service's own
// inbound request, what we actually want), Kind=3 (CLIENT — this
// service's own outbound calls to its neighbors, correctly excluded), and
// some Kind=0 (UNSPECIFIED, also correctly excluded — an extra
// duplicate-looking record Beyla emits alongside the properly-kinded one,
// not the one we want per request).
function serviceWhereClause(serviceName, instanceIds) {
  let clause = `ServiceName = ${sqlString(serviceName)} AND Kind = 2`;
  if (instanceIds && instanceIds.size > 0) {
    const ids = [...instanceIds].map(sqlString).join(', ');
    // ResourceAttributes is Map(LowCardinality(String), String) in the
    // exporter's default schema — map subscript syntax, not a JOIN.
    clause += ` AND ResourceAttributes['service.instance.id'] IN (${ids})`;
  }
  return clause;
}

// Recent span durations for one service — the trace-derived "slow" +
// freshness signal, shown only for services with entry.otel.enabled true.
// instanceIds (optional): see serviceWhereClause above — narrows the
// query to one specific container's own observed processes when its Beyla
// name might be shared with something else on the host.
async function recentSpanSamples(serviceName, instanceIds) {
  const rows = await queryClickHouse(`
    SELECT toUnixTimestamp64Milli(Timestamp) AS StartMs, Duration
    FROM ${CLICKHOUSE_TRACES_TABLE}
    WHERE ${serviceWhereClause(serviceName, instanceIds)}
      AND Timestamp >= now() - INTERVAL ${LOOKBACK_SECONDS} SECOND
    ORDER BY Timestamp DESC
    LIMIT 20
  `);

  let lastSeenMs = null;
  const durationsMs = [];
  for (const row of rows) {
    const startedMs = Number(row.StartMs);
    if (lastSeenMs === null || startedMs > lastSeenMs) lastSeenMs = startedMs;
    durationsMs.push(Number(row.Duration) / 1e6); // Duration is nanoseconds
  }
  return { lastSeenMs, durationsMs };
}

// Ingestion/volume visibility: how much telemetry is actually flowing in
// for this service right now — spans/sec into CLICKHOUSE_TRACES_TABLE and
// logs/sec into CLICKHOUSE_LOG_PATTERNS_TABLE. log_patterns stores
// pre-aggregated (pattern, count) rows per flush window, not raw lines —
// see that table's own CREATE TABLE comment — so this sums Count rather
// than counting rows. Deliberately distinct from red.requestsPerSec
// (computed elsewhere from Beyla's own eBPF counters): that's business
// request throughput, this is raw telemetry ingestion volume, and the two
// can differ a lot — one request can fan out into many spans, and log
// volume has nothing to do with request volume at all. A short fixed
// window (60s), not LOOKBACK_SECONDS/STALE_AFTER_SECONDS's longer ones,
// because a rate should answer "right now," not "anytime in the last 5
// minutes."
const INGESTION_WINDOW_SECONDS = 60;

async function fetchSpansPerSec(serviceName, instanceIds) {
  try {
    let clause = `ServiceName = ${sqlString(serviceName)}`;
    if (instanceIds && instanceIds.size > 0) {
      const ids = [...instanceIds].map(sqlString).join(', ');
      clause += ` AND ResourceAttributes['service.instance.id'] IN (${ids})`;
    }
    const rows = await queryClickHouse(`
      SELECT count() AS Cnt
      FROM ${CLICKHOUSE_TRACES_TABLE}
      WHERE ${clause} AND Timestamp >= now() - INTERVAL ${INGESTION_WINDOW_SECONDS} SECOND
    `);
    const cnt = rows[0] ? Number(rows[0].Cnt) : 0;
    return Number.isFinite(cnt) ? cnt / INGESTION_WINDOW_SECONDS : null;
  } catch {
    return null;
  }
}

async function fetchLogsPerSec(serviceName) {
  try {
    const rows = await queryClickHouse(`
      SELECT sum(Count) AS Cnt
      FROM ${CLICKHOUSE_LOG_PATTERNS_TABLE}
      WHERE ServiceName = ${sqlString(serviceName)} AND Timestamp >= now() - INTERVAL ${INGESTION_WINDOW_SECONDS} SECOND
    `);
    const cnt = rows[0] ? Number(rows[0].Cnt) : 0;
    return Number.isFinite(cnt) ? cnt / INGESTION_WINDOW_SECONDS : null;
  } catch {
    return null;
  }
}

// Node's fetch (undici) throws a generic "fetch failed" TypeError for
// connection-level problems (ClickHouse not listening yet, wrong host,
// etc.) and buries the actual reason (ECONNREFUSED, ENOTFOUND, ...) in
// err.cause instead of err.message — so a naive String(err) here is
// exactly how you end up with an opaque "502" and no way to tell
// "ClickHouse isn't up yet" from "wrong URL" from anything else. Surface
// the cause.
function describeFetchError(err) {
  const cause = err && err.cause;
  const causeCode = cause && (cause.code || cause.message);
  return causeCode ? `${err.message} (${causeCode})` : String((err && err.message) || err);
}

// Generalized from a p95-only helper — p95 alone can hide a bad tail (a
// service that's fast MOST of the time but has occasional multi-second
// outliers looks fine on p95 and terrible on p99). Every mainstream APM
// tool (Datadog, Grafana, New Relic) shows at least p50/p95/p99 together
// for exactly this reason, so traceSignal below now computes all three
// off the same sorted sample instead of just one.
function quantile(sortedAsc, q) {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil(sortedAsc.length * q) - 1);
  return sortedAsc[Math.max(idx, 0)];
}

// Trace-derived signal for one service that has opted into OTel: "recent"
// (a span within STALE_AFTER_SECONDS), "idle" (spans exist but not
// recently), or "no-data" (nothing yet, or the query failed). Never used to
// assert "down" on its own — silence only ever means "no evidence."
async function traceSignal(serviceName, instanceIds) {
  try {
    const { lastSeenMs, durationsMs } = await recentSpanSamples(serviceName, instanceIds);
    if (lastSeenMs === null) {
      return { status: 'no-data', lastSeenSecondsAgo: null, p50Ms: null, p95Ms: null, p99Ms: null, slow: null, error: null };
    }
    const ageSeconds = (Date.now() - lastSeenMs) / 1000;
    const sorted = [...durationsMs].sort((a, b) => a - b);
    const p50Ms = quantile(sorted, 0.5);
    const p95Ms = quantile(sorted, 0.95);
    const p99Ms = quantile(sorted, 0.99);
    return {
      status: ageSeconds <= STALE_AFTER_SECONDS ? 'recent' : 'idle',
      lastSeenSecondsAgo: ageSeconds,
      p50Ms,
      p95Ms,
      p99Ms,
      slow: p95Ms !== null && p95Ms > SLOW_THRESHOLD_MS,
      error: null,
    };
  } catch (err) {
    return {
      status: 'no-data',
      lastSeenSecondsAgo: null,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      slow: null,
      error: describeFetchError(err),
    };
  }
}

// --- Beyla name resolution: zero-touch, no changes to anyone's stack -------
// traceSignal() above queries Tempo by CONTAINER name (what podotype and
// the person both call the service). Beyla, with no OTEL_SERVICE_NAME set on
// the target process, names it after its runtime instead (python3.12, node,
// java, or the Go binary's own filename) — there's no Docker/OCI
// container-name tier in Beyla's naming precedence outside Kubernetes, and
// (confirmed against Grafana's own Beyla docs — it has no container-identity
// attribute of any kind outside Kubernetes) there's no config flag to make
// it add one either. The two names rarely match, so a plain container-name
// query comes up empty even when Tempo has real data.
//
// The tempting fix is "tell people to set OTEL_SERVICE_NAME on their
// services" — but that's editing a stack podotype was supposed to watch
// with zero changes to it, for a detail that has nothing to do with the
// person's own code. Coroot doesn't ask for that either: its node-agent
// never relies on the observed process to self-report who it is — it
// correlates entirely from the outside, using its own privileged host access
// to match kernel-level activity back to container metadata it already has.
//
// This does the same thing, and — importantly — by CGROUP, not by assuming
// a container's first process (PID1) is the one actually serving requests.
// That assumption breaks for anything real: a gunicorn/uvicorn master
// forking worker processes, a JVM started via a wrapper shell script, a
// container running under tini/dumb-init/s6-overlay. Cgroup membership is
// inherited by every child a container's process tree forks — it's the same
// mechanism Docker itself uses to apply CPU/memory limits to the WHOLE
// container, not just its first process — so matching on cgroup instead of
// PID1 covers all of those cases the same way, automatically.
//
// Mechanically: Beyla stamps every span's resource with
// "service.instance.id": "<host>:<pid>" (a host-side PID, since Beyla runs
// with pid: host). `app` reads /hostproc/<pid>/cgroup for that PID — a
// read-only bind mount of the HOST's /proc (see docker-compose.yml's "app"
// volumes; deliberately NOT pid: host or privileged on `app` itself, just
// read access to /proc's text files) — and pulls the container ID straight
// out of the cgroup path. That gives a direct containerId -> service.name
// mapping with no assumption about which process in the container Beyla
// happened to observe.
const HOST_PROC = process.env.HOST_PROC_PATH || '/hostproc';

// --- Host-level stats (CPU/memory/load for the machine itself, not any
// one container) --------------------------------------------------------
//
// Everything below is per-CONTAINER (Docker stats, Beyla's per-process
// view). None of it answers "is the HOST itself under pressure" — a host
// that's swapping or out of disk can take every container down at once in
// a way no single container's own numbers would explain. This reads the
// same already-mounted, already-read-only HOST_PROC (see the cgroup-
// resolution comment above for why that mount exists and what it does and
// doesn't grant) — no new mount, no new privilege, just reading more of
// what's already exposed there. Kept genuinely lightweight: sampled on
// the same interval as pollContainerHealth below, not a new poller.
let hostCpuPrevSample = null; // { idle, total, atMs } — needed to turn /proc/stat's cumulative jiffy counters into a percent
let hostStatsCurrent = null;
let hostStatsHistory = []; // bounded — see pushBoundedHistory's own cap
const HOST_STATS_HISTORY_MAX_POINTS = 180; // ~15min at a 5s poll cadence, matches containerStatsHistory's own sizing intent

function readHostCpuPercent() {
  let text;
  try {
    text = fs.readFileSync(`${HOST_PROC}/stat`, 'utf8');
  } catch {
    return null;
  }
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  // user, nice, system, idle, iowait, irq, softirq, steal, guest, guest_nice
  const idle = (parts[3] || 0) + (parts[4] || 0);
  const total = parts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const nowMs = Date.now();
  const prev = hostCpuPrevSample;
  hostCpuPrevSample = { idle, total, atMs: nowMs };
  if (!prev) return null; // first sample just establishes a baseline, same pattern pollBeylaRedMetrics uses
  const totalDelta = total - prev.total;
  const idleDelta = idle - prev.idle;
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
}

function readHostMem() {
  let text;
  try {
    text = fs.readFileSync(`${HOST_PROC}/meminfo`, 'utf8');
  } catch {
    return { totalBytes: null, usedBytes: null, percent: null };
  }
  const grab = (key) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm'));
    return m ? Number(m[1]) * 1024 : null;
  };
  const totalBytes = grab('MemTotal');
  // MemAvailable (not MemFree) is the kernel's own "usable without
  // swapping" estimate, already accounting for reclaimable cache/buffers —
  // the same number `free -h`'s "available" column shows, and the right
  // one to alert on (MemFree alone looks scarier than it is on a healthy
  // Linux box, which uses free RAM as disk cache by design).
  const availableBytes = grab('MemAvailable');
  if (totalBytes === null) return { totalBytes: null, usedBytes: null, percent: null };
  const usedBytes = availableBytes !== null ? totalBytes - availableBytes : null;
  const percent = usedBytes !== null && totalBytes > 0 ? (usedBytes / totalBytes) * 100 : null;
  return { totalBytes, usedBytes, percent };
}

function readHostLoad() {
  let text;
  try {
    text = fs.readFileSync(`${HOST_PROC}/loadavg`, 'utf8');
  } catch {
    return { load1: null, load5: null, load15: null };
  }
  const [l1, l5, l15] = text.trim().split(/\s+/).map(Number);
  return {
    load1: Number.isFinite(l1) ? l1 : null,
    load5: Number.isFinite(l5) ? l5 : null,
    load15: Number.isFinite(l15) ? l15 : null,
  };
}

function readHostCpuCount() {
  let text;
  try {
    text = fs.readFileSync(`${HOST_PROC}/cpuinfo`, 'utf8');
  } catch {
    return null;
  }
  const count = (text.match(/^processor\s*:/gm) || []).length;
  return count || null;
}

function readHostUptimeSeconds() {
  let text;
  try {
    text = fs.readFileSync(`${HOST_PROC}/uptime`, 'utf8');
  } catch {
    return null;
  }
  const first = parseFloat(text.trim().split(/\s+/)[0]);
  return Number.isFinite(first) ? first : null;
}

function sampleHostStats() {
  const cpuPercent = readHostCpuPercent();
  const mem = readHostMem();
  const load = readHostLoad();
  const nowMs = Date.now();
  hostStatsCurrent = {
    cpu: { percent: cpuPercent, cores: readHostCpuCount(), load1: load.load1, load5: load.load5, load15: load.load15 },
    memory: mem,
    uptimeSeconds: readHostUptimeSeconds(),
    checkedAt: new Date(nowMs).toISOString(),
  };
  hostStatsHistory.push({ t: nowMs, cpuPercent, memPercent: mem.percent });
  if (hostStatsHistory.length > HOST_STATS_HISTORY_MAX_POINTS) {
    hostStatsHistory = hostStatsHistory.slice(hostStatsHistory.length - HOST_STATS_HISTORY_MAX_POINTS);
  }
}

// Total spans stored (and the average ingest rate implied by that) for an
// explicit time window — what UsageStats.jsx shows on the Overview page,
// scoped to whatever range its TimeRangePicker has selected, instead of
// the fixed "last 60s" ingest figure it showed before. Deliberately counts
// everything in otel_traces for the window, not just watched services'
// own rows — Beyla instruments every container Docker runs, and someone
// asking "what is this instance actually storing/ingesting" wants the
// real number ClickHouse is holding, not a number that silently excludes
// whatever isn't currently watched (see bufferTraceRows in
// apps/hosted/agent/server.js for the hosted side's DIFFERENT
// watched-only philosophy — this is self-hosted, there's no per-tenant
// billing reason to under-count here).
app.get('/api/usage-range', async (req, res) => {
  try {
    const since = req.query.since ? new Date(req.query.since) : null;
    const until = req.query.until ? new Date(req.query.until) : null;
    if (!since || !until || Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || since >= until) {
      return res.status(400).json({ error: 'since and until (ISO timestamps, since < until) are required' });
    }
    const rows = await queryClickHouse(`
      SELECT count() AS Cnt
      FROM ${CLICKHOUSE_TRACES_TABLE}
      WHERE Timestamp >= parseDateTime64BestEffort(${sqlString(since.toISOString())})
        AND Timestamp <= parseDateTime64BestEffort(${sqlString(until.toISOString())})
    `);
    const spansInRange = rows[0] ? Number(rows[0].Cnt) : 0;
    const rangeSeconds = Math.max(1, (until.getTime() - since.getTime()) / 1000);
    res.json({ spansInRange, ingestRatePerSecInRange: spansInRange / rangeSeconds });
  } catch (err) {
    console.error('[app] /api/usage-range failed:', err.message);
    res.status(502).json({ error: 'could not compute usage for that range right now' });
  }
});

app.get('/api/host-stats', (req, res) => {
  // Optional ?minutes= trims the in-memory history buffer to whatever
  // window the Overview page's own time-range picker has selected —
  // HostStatsPanel.jsx now threads that through so this one panel moves
  // with the rest of the page instead of always showing its own fixed
  // window. Bounded by what's actually still in memory (see
  // HOST_STATS_HISTORY_MAX_POINTS above, ~15 minutes at this poll
  // cadence) — there's no persistent host-metrics store, so asking for
  // more than that just returns everything that's left, same as before
  // this param existed.
  let history = hostStatsHistory;
  const minutes = req.query.minutes ? parseFloat(req.query.minutes) : null;
  if (minutes && Number.isFinite(minutes) && minutes > 0) {
    const cutoff = Date.now() - minutes * 60 * 1000;
    history = hostStatsHistory.filter((p) => p.t >= cutoff);
  }
  res.json({
    available: hostStatsCurrent !== null,
    current: hostStatsCurrent,
    history,
    historyRetentionSeconds: (HOST_STATS_HISTORY_MAX_POINTS * CONTAINER_STATS_POLL_INTERVAL_MS) / 1000,
  });
});


// cgroup v1 lines look like "5:pids:/docker/<64-hex>"; cgroup v2 (unified)
// like "0::/system.slice/docker-<64-hex>.scope". The surrounding path shape
// differs by cgroup driver/version, but a 64-char hex run is the container
// ID either way, so match on that directly instead of the exact path shape.
function containerIdFromCgroup(pid) {
  let text;
  try {
    text = fs.readFileSync(`${HOST_PROC}/${pid}/cgroup`, 'utf8');
  } catch (err) {
    // ENOENT is normal and expected — the pid already exited by the time we
    // got to it. Anything else (EACCES, /hostproc missing entirely) is worth
    // knowing about instead of silently degrading to "no data" forever.
    if (err.code !== 'ENOENT') {
      console.warn(`[beyla-resolve] cgroup read failed for pid ${pid}: ${err.code || err.message}`);
    }
    return null;
  }
  const match = text.match(/[0-9a-f]{64}/);
  if (!match) {
    console.warn(`[beyla-resolve] pid ${pid} cgroup has no 64-hex container id — raw content: ${text.trim().slice(0, 200)}`);
  }
  return match ? match[0] : null;
}

// pid -> containerId is cheap (one file read) but still worth a short cache
// since the same pid gets looked up once per trace it appears in across a
// scan. PIDs get reused by the kernel over time, so this TTL stays short.
const pidContainerCache = new Map(); // pid -> { containerId: string|null, resolvedAt: number }
const PID_CONTAINER_CACHE_TTL_MS = 60000;

function resolvedContainerIdForPid(pid) {
  const cached = pidContainerCache.get(pid);
  if (cached && Date.now() - cached.resolvedAt < PID_CONTAINER_CACHE_TTL_MS) return cached.containerId;
  const containerId = containerIdFromCgroup(pid);
  pidContainerCache.set(pid, { containerId, resolvedAt: Date.now() });
  return containerId;
}

// containerId -> beylaServiceName, and containerId -> Set(service.instance.id)
// — rebuilt every RED-metrics poll cycle (see pollBeylaRedMetrics below)
// straight from Beyla's own Prometheus scrape, resolving each pid to a
// container via cgroup (same containerIdFromCgroup/resolvedContainerIdForPid
// as before). This USED to be built by scanning Tempo's recent trace data
// instead — which meant this resolution, and everything downstream of it
// (RED metrics AND the trace-name fallback), broke the moment Tempo had no
// data for any reason: full disk, Tempo itself restarting, or (seen in
// production on this project) Beyla's OTLP export to Tempo going quiet
// after a reboot while Beyla itself was still perfectly healthy and still
// serving its own /metrics fine. That was a real, needless single point of
// failure: two independent signals (Beyla's request counters, Beyla's
// trace export) ended up coupled through a THIRD system (Tempo) that
// neither of them actually needs for this lookup. Beyla's own scrape
// already carries both service.name and service.instance.id together on
// every metric line, so there was never a reason to go via Tempo at all —
// this now depends on exactly two things: the Docker socket, and Beyla's
// /metrics endpoint being reachable. A Tempo outage no longer breaks RED
// metrics, and (since the trace fallback below reuses this same map) no
// longer breaks trace-name resolution either — only an actual loss of
// trace DATA does, which is the only thing that should.
let beylaNameMapFromMetrics = { containerIdToName: new Map(), containerIdToInstanceIds: new Map(), updatedAt: 0 };

// FIX — this comment used to claim service.instance.id is ALWAYS
// "<host>:<pid>". Confirmed live that's wrong for a containerized process
// on Beyla 3.33.0: its instance id is "<service>.<container_name>", no ':'
// at all, so this silently returned null for every real container — see
// pollBeylaRedMetrics's container_name-based primary path above, which now
// runs first. This function (and its "<host>:<pid>" parsing) is kept only
// as the fallback for a process Beyla can't tie to any container at all
// (host-level daemons, which do still use that shape).
function extractPidFromInstanceId(instanceId) {
  if (!instanceId) return null;
  const idx = instanceId.lastIndexOf(':');
  const raw = idx >= 0 ? instanceId.slice(idx + 1) : instanceId;
  const pid = parseInt(raw, 10);
  return Number.isFinite(pid) ? pid : null;
}

// Resolved name for one container — just a map lookup against whatever the
// last RED-metrics poll built. null means "not seen this cycle", which is
// normal right after a container starts, before Beyla has scraped anything
// from it yet — worth re-trying, not a permanent failure.
function resolveBeylaServiceName(container) {
  if (!container) return null;
  return beylaNameMapFromMetrics.containerIdToName.get(container.id) || null;
}

// This container's own known service.instance.id values (host PIDs), for
// scoping a ClickHouse query to just this container even when its Beyla name
// is shared with something else on the host — see serviceWhereClause above.
// Always call alongside resolveBeylaServiceName for the SAME container so
// the two come from the same cache snapshot.
function resolveBeylaInstanceIds(container) {
  if (!container) return null;
  return beylaNameMapFromMetrics.containerIdToInstanceIds.get(container.id) || null;
}

// ---- RED metrics: request rate + error rate from Beyla's own counters -----
// Duration (the "D" in RED) already comes from real span durations pulled
// straight out of Tempo (see recentSpanSamples/traceSignal) — that's
// accurate as-is, nothing to add there. Rate and error-rate are different:
// Tempo's search endpoint only returns a capped, most-recent slice of
// traces (20-50), so counting THOSE to estimate "requests per second" or
// "% erroring" undercounts badly the moment real traffic exceeds that cap.
// Beyla already counts every single request internally to build its own
// histograms, uncapped — apps/shared/beyla/config.yml turns on its Prometheus endpoint
// so that count is readable, and this polls it directly (no Prometheus
// server involved; podotype is its own single scraper here, so none of
// the usual "instance/job label gets overwritten by the scraper" caveat
// applies — the labels below are exactly what Beyla put on the metric).
//
// Prometheus counters are cumulative since Beyla started, so a single
// snapshot is meaningless on its own — this keeps the previous poll's
// totals per (service, instance) and turns the delta between two polls
// into a rate. A negative delta means Beyla itself restarted (counter
// reset back to zero); that poll is treated as a fresh baseline rather
// than a real drop to a negative rate.
// Self-hosted's combined container runs beyla as a subprocess alongside this
// process (see docker-entrypoint.sh) rather than as its own service, so the
// default is localhost now, not the old 'beyla' compose service name. The
// hosted build still runs beyla as a separate container and overrides
// BEYLA_HOST (or BEYLA_METRICS_URL directly) back to that service name.
const BEYLA_HOST = process.env.BEYLA_HOST || 'localhost';
const BEYLA_METRICS_URL = process.env.BEYLA_METRICS_URL || `http://${BEYLA_HOST}:9464/metrics`;
const RED_METRICS_POLL_INTERVAL_MS = 15000;

// key `${serviceName}|${instanceId}` -> { totalCount, err5xxCount, atMs } —
// the raw cumulative counters as of the last successful poll.
let redMetricsPrevSnapshot = new Map();
// same key -> { requestsPerSec, errorRate, computedAt } — the last
// computed rate, i.e. what /api/status actually reads. Absent key means
// "never computed yet" (still warming up, or genuinely no traffic).
let redMetricsCurrent = new Map();
let redMetricsLastError = null;
let redMetricsLastRawSampleNames = []; // small debug aid — see /api/debug/beyla-metrics
// same key -> bounded array of { t, requestsPerSec, errorRate }, oldest
// first — the request-rate/error-rate half of GET
// /api/services/:name/metrics-history. Same METRICS_HISTORY_POINTS cap as
// containerStatsHistory, kept as its own Map since this is keyed by Beyla's
// service|instance key rather than a Docker container id.
let redMetricsHistory = new Map();

// serviceName (canonical watched name, NOT the beyla-resolved runtime
// name — this is keyed the same way GET /api/services/:name/metrics-history
// is queried, by WHAT THE PERSON WATCHES) -> bounded array of
// { t, p50Ms, p95Ms, p99Ms }, oldest first, capped at
// METRICS_HISTORY_POINTS — the latency half of the Traces tab's new
// sparkline. Sampled from the exact same traceSignal() call
// evaluateAlerts() already makes every ALERT_EVAL_INTERVAL_MS to check
// the latency alert threshold, so this costs nothing extra: a second
// consumer of a ClickHouse query this file was already running, not a
// new poller or a new query.

// Minimal Prometheus text-exposition-format line parser — just enough to
// pull `metric_name{label="value",...} number` apart. Not a general
// parser (ignores HELP/TYPE comment lines, doesn't handle every escaping
// edge case Prometheus's format technically allows), but Beyla's own
// output is straightforward enough that this is plenty.
function parsePrometheusMetricsText(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(-?[0-9.eE+-]+)\s*$/);
    if (!m) continue;
    const name = m[1];
    const labelsRaw = m[3] || '';
    const value = Number(m[4]);
    if (!Number.isFinite(value)) continue;
    const labels = {};
    const labelRe = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
    let lm;
    while ((lm = labelRe.exec(labelsRaw))) {
      labels[lm[1]] = lm[2].replace(/\\"/g, '"');
    }
    out.push({ name, labels, value });
  }
  return out;
}

// Beyla's Prometheus metric/label naming has some variance across
// versions and hasn't been confirmed against a live scrape yet — these
// candidate lists are deliberately forgiving rather than hard-coded to
// one exact name, so this keeps working (or at least fails obviously via
// redMetricsLastRawSampleNames) if the real names differ slightly. See
// /api/debug/beyla-metrics for confirming the real names against a live
// deployment.
function isRequestDurationCountMetric(name) {
  return name.endsWith('_count') && name.includes('request_duration') && name.includes('server');
}
function firstLabel(labels, candidates) {
  for (const c of candidates) {
    if (labels[c] !== undefined) return labels[c];
  }
  return null;
}

async function pollBeylaRedMetrics() {
  let text;
  try {
    const res = await fetch(BEYLA_METRICS_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    redMetricsLastError = err.message;
    return; // leave existing redMetricsCurrent as last-known-good rather than blanking it
  }
  redMetricsLastError = null;

  const parsed = parsePrometheusMetricsText(text);
  redMetricsLastRawSampleNames = [...new Set(parsed.map((p) => p.name))].slice(0, 40);

  // Rebuild the container-name/instance-id map from THIS SAME scrape —
  // see beylaNameMapFromMetrics's comment for why this replaced scanning
  // Tempo's trace data. Every metric line carries both service_name and
  // service_instance_id (not just the request-duration ones RED uses
  // below), so this scans the whole parsed set independently of the RED
  // aggregation just below — a container with zero requests so far still
  // resolves here as long as Beyla has scraped anything about it (e.g.
  // target_info, emitted on discovery regardless of traffic).
  //
  // FIX — confirmed live (hosted's identical copy of this logic, same
  // Beyla config/version): the assumption baked into
  // extractPidFromInstanceId ("service.instance.id is always
  // <host>:<pid>") is wrong for a containerized process on Beyla 3.33.0 —
  // its instance id there is actually "<service>.<container_name>", no
  // ':' at all, so extractPidFromInstanceId silently returned null for
  // every real container and this map stayed empty regardless of the
  // Docker socket/cgroup plumbing being fine. Beyla stamps a
  // `container_name` label directly on these same metric lines — resolve
  // via that first (a straight name lookup against listContainers(), no
  // cgroup/pid guessing), and only fall back to the old pid/cgroup path
  // for a process Beyla can't tie to any container at all (host-level
  // daemons — see apps/shared/beyla/config.yml's exe_path excludes — which do use the
  // "<host>:<pid>" shape).
  let nameToId = new Map();
  try {
    for (const c of await listContainers()) nameToId.set(c.name, c.id);
  } catch (err) {
    console.warn(`[beyla-resolve] listContainers failed, falling back to cgroup-only resolution this poll: ${err.message}`);
  }

  const newContainerIdToName = new Map();
  const newContainerIdToInstanceIds = new Map();
  const pidsSeenThisPoll = new Set();
  let byContainerName = 0;
  for (const { labels } of parsed) {
    const serviceName = firstLabel(labels, ['service_name', 'service']);
    const instanceId = firstLabel(labels, ['service_instance_id', 'instance_id', 'target_instance', 'instance']);
    if (!serviceName || !instanceId) continue;

    const containerName = firstLabel(labels, ['container_name']);
    let containerId = containerName ? nameToId.get(containerName) : null;
    if (!containerId) {
      const pid = extractPidFromInstanceId(instanceId);
      if (pid === null || pidsSeenThisPoll.has(pid)) continue;
      pidsSeenThisPoll.add(pid);
      containerId = resolvedContainerIdForPid(pid);
    } else {
      byContainerName += 1;
    }
    if (!containerId) continue;
    newContainerIdToName.set(containerId, serviceName);
    if (!newContainerIdToInstanceIds.has(containerId)) newContainerIdToInstanceIds.set(containerId, new Set());
    newContainerIdToInstanceIds.get(containerId).add(instanceId);
  }
  console.warn(
    `[beyla-resolve] ${parsed.length} metric lines, ${byContainerName} resolved via container_name, ${pidsSeenThisPoll.size} distinct pids checked via cgroup fallback, ${newContainerIdToName.size} resolved to a container total`
  );
  beylaNameMapFromMetrics = {
    containerIdToName: newContainerIdToName,
    containerIdToInstanceIds: newContainerIdToInstanceIds,
    updatedAt: Date.now(),
  };

  // Aggregate this poll's cumulative totals per (service, instance).
  const snapshot = new Map(); // key -> { totalCount, err5xxCount }
  for (const { name, labels, value } of parsed) {
    if (!isRequestDurationCountMetric(name)) continue;
    const serviceName = firstLabel(labels, ['service_name', 'service']);
    const instanceId = firstLabel(labels, ['service_instance_id', 'instance_id', 'target_instance', 'instance']);
    if (!serviceName) continue;
    const key = `${serviceName}|${instanceId || ''}`;
    const statusCode = firstLabel(labels, ['http_response_status_code', 'status_code']);
    const entry = snapshot.get(key) || { totalCount: 0, err5xxCount: 0 };
    entry.totalCount += value;
    if (statusCode && statusCode.startsWith('5')) entry.err5xxCount += value;
    snapshot.set(key, entry);
  }

  const nowMs = Date.now();
  for (const [key, cur] of snapshot) {
    const prev = redMetricsPrevSnapshot.get(key);
    if (prev) {
      const deltaMs = nowMs - prev.atMs;
      const deltaCount = cur.totalCount - prev.totalCount;
      if (deltaCount >= 0 && deltaMs > 0) {
        const deltaErr = cur.err5xxCount - prev.err5xxCount;
        const requestsPerSec = deltaCount / (deltaMs / 1000);
        const errorRate = deltaCount > 0 ? Math.max(0, deltaErr) / deltaCount : 0;
        redMetricsCurrent.set(key, { requestsPerSec, errorRate, computedAt: nowMs });
        pushBoundedHistory(redMetricsHistory, key, { t: nowMs, requestsPerSec, errorRate });
      }
      // A negative delta (Beyla restarted, counter reset) just skips this
      // cycle's computation — redMetricsCurrent keeps its last-known value
      // until the next poll has two consistent samples to diff again.
    }
  }
  redMetricsPrevSnapshot = new Map([...snapshot].map(([k, v]) => [k, { ...v, atMs: nowMs }]));

  // Drop computed entries for keys that vanished this poll (container
  // gone) so a stopped service doesn't show a rate frozen forever.
  for (const key of redMetricsCurrent.keys()) {
    if (!snapshot.has(key)) redMetricsCurrent.delete(key);
  }
  for (const key of redMetricsHistory.keys()) {
    if (!snapshot.has(key)) redMetricsHistory.delete(key);
  }
}

// Aggregates over every instance id this container is known to have used
// (normally just one) — mirrors resolveBeylaInstanceIds's "PIDs are always
// unique even when the runtime name collides" scoping used for traces.
function redMetricsForBeylaTarget(serviceName, instanceIds) {
  if (!serviceName) return null;
  const ids = instanceIds && instanceIds.size > 0 ? [...instanceIds] : [''];
  let totalRps = 0;
  let weightedErrSum = 0;
  let matched = false;
  for (const id of ids) {
    const hit = redMetricsCurrent.get(`${serviceName}|${id}`);
    if (!hit) continue;
    matched = true;
    totalRps += hit.requestsPerSec;
    weightedErrSum += hit.errorRate * hit.requestsPerSec;
  }
  if (!matched) return null;
  return {
    requestsPerSec: totalRps,
    errorRate: totalRps > 0 ? weightedErrSum / totalRps : 0,
    source: 'beyla',
  };
}

// The p95 stat on a watched card answers "is this service slow right now" —
// it never says which request, which downstream call, or why. Tempo already
// has that (every span opted into full tracing produces), podotype just
// wasn't exposing it. These two helpers back the tracing panel's expanded
// view: a shortlist of recent traces (slowest first, so the interesting one
// is at the top) and, per trace, a per-span breakdown sorted the same way —
// the top of that list IS "what's slow, where, why": whichever span ate the
// most wall-clock time within that one request.

// Health-check endpoints (Docker's own HEALTHCHECK curling /actuator/health
// every few seconds, k8s-style /healthz/readyz/livez, etc.) fire far more
// often than anything a person actually does — often every 5-15s, against
// LOOKBACK_SECONDS's 5-minute window. Left in, they fill every slot of a
// small "recent traces" list before a single real request gets a look in
// (exactly what was happening here: 20 most-recent traces, all
// /actuator/health, real API calls pushed out entirely). This is a
// best-effort name match, not a Tempo-side filter — see the comment on
// recentTraceList for why it's done this way.
const HEALTH_CHECK_OPERATION_RE = /\b(health|healthz|readyz|livez|actuator|ping)\b/i;

// A real inbound HTTP request's root span — the thing Spring MVC (or any
// other framework's) auto-instrumentation names — always looks like
// "METHOD /path" (e.g. "GET /api/orders"). Background spans that end up
// rootless for unrelated reasons (a JDBC connection pool's own housekeeper
// thread validating idle connections, a scheduled task, a messaging
// consumer poll) get named after whatever they touched instead — a table
// name, a DB name, a queue name — never a method+path. This lets us tell
// "an actual request" apart from "some other span that happened to have no
// parent" without needing the span's `kind`, which Tempo's search summary
// doesn't return.
const HTTP_OPERATION_RE = /^[A-Z]+\s+\S+/;

// SpanName alone is already a good label for HTTP spans ("GET /api/orders"
// — see above) but plenty of spans aren't HTTP at all: a DB query, a gRPC
// call, a queue publish. Beyla still names those spans something (often
// just the table/queue name), but the OTLP semantic-convention attributes
// it attaches carry the more useful, standardized version of that same
// information — this pulls the best one available instead of falling back
// to whatever raw SpanName happened to be. Order matters: HTTP spans are
// already well-named by SpanName itself, so this only kicks in for
// everything else.
function deriveSpanLabel(spanName, spanAttributes) {
  if (spanName && HTTP_OPERATION_RE.test(spanName)) return spanName;
  const attrs = spanAttributes || {};
  if (attrs['db.statement']) {
    const stmt = attrs['db.statement'].trim().replace(/\s+/g, ' ');
    return stmt.length > 80 ? `${stmt.slice(0, 80)}…` : stmt;
  }
  if (attrs['db.system'] && attrs['db.operation']) return `${attrs['db.system']} ${attrs['db.operation']}`;
  if (attrs['db.system']) return `${attrs['db.system']} query`;
  if (attrs['rpc.system'] && attrs['rpc.method']) {
    const svc = attrs['rpc.service'] ? `${attrs['rpc.service']}/` : '';
    return `${attrs['rpc.system']} ${svc}${attrs['rpc.method']}`;
  }
  if (attrs['messaging.system'] && attrs['messaging.destination.name']) {
    return `${attrs['messaging.system']} → ${attrs['messaging.destination.name']}`;
  }
  return spanName || '(unnamed span)';
}


// Tempo's search summary (what recentTraceList's main query returns) often
// has an empty rootTraceName for a Beyla-sourced trace — not the "not yet
// received" placeholder (see cleanTempoField above), just genuinely no
// root-span name, because the trace's actual absolute root usually turns
// out to be an unwatched client-side hop (e.g. dummy-stack's loadgen
// firing a plain `curl` in a loop — a brand-new short-lived process each
// time, which Beyla's periodic process scan can easily miss entirely
// before it exits) that Tempo never received a span for at all. Confirmed
// by hand against this project's own live traces: /api/traces/<id> (the
// FULL trace, not the search summary) shows every real hop's operation
// correctly as "GET /work" — python3.12, svc, java, node all agree — it's
// only the lightweight search index's single summary field that comes up
// empty. Rather than showing the caller a bare runtime name ("svc") for
// every row, which is what our fallback used to do and is exactly the
// kind of unhelpful label the person using this dashboard flagged, this
// fills it in from the one thing we can actually trust: this container's
// OWN span in the full trace, once we look. Bounded and cheap: only ever
// called for the up-to-8 traces recentTraceList is about to return (never
// for the wider ~50-trace candidate pool it filters from), and cached
// forever per traceId afterward — a historical trace's own operation name
// never changes, so repeated 5s-poll re-fetches of the same trace cost
// nothing past the first.
const traceOperationCache = new Map(); // traceId -> string | null
const TRACE_OPERATION_CACHE_MAX = 2000;

async function resolveTraceOperationForService(traceId, forService) {
  if (traceOperationCache.has(traceId)) return traceOperationCache.get(traceId);
  let operation = null;
  try {
    const detail = await fetchTraceDetail(traceId);
    const candidates = (detail.spans || []).filter((s) => s.service === forService);
    // Prefer this service's own HTTP-server-shaped span ("GET /work") over
    // any other spans it happens to have in the same trace ("processing",
    // "in queue" — real spans seen in this project's own data, clearly not
    // what anyone wants as the list's headline label).
    const httpSpan = candidates.find((s) => HTTP_OPERATION_RE.test(s.operation || ''));
    operation = (httpSpan || candidates[0] || {}).operation || null;
  } catch {
    // best-effort enrichment only — recentTraceList's existing fallback
    // (service name, or the trace ID itself) still applies if this fails
  }
  if (traceOperationCache.size >= TRACE_OPERATION_CACHE_MAX) {
    traceOperationCache.delete(traceOperationCache.keys().next().value); // drop oldest, cheaply
  }
  traceOperationCache.set(traceId, operation);
  return operation;
}

// Recent traces for one service, slowest-first, with health-check noise
// filtered out. Deliberately small (8 returned) — this is "here's what to
// look at first," not a full trace search UI.
//
// Over-fetches (50 instead of 20) specifically so the health-check filter
// below has enough real traffic left to work with: filtering after a
// 20-trace fetch would just as often leave nothing, since those 20 slots
// can be entirely health checks in a quiet window. The tradeoff is one
// slightly heavier Tempo query per expand, not per poll tick.
// Tempo's own search index fills rootServiceName/rootTraceName in lazily —
// when Tempo has enough spans to compute a trace's duration but hasn't yet
// indexed that trace's actual root span, it returns the literal string
// "<root span not yet received>" instead of leaving the field empty (this
// was Tempo's own placeholder, confirmed against several long-standing
// grafana/tempo GitHub issues — #1476, #4693, #6762). ClickHouse has no
// equivalent quirk to work around here: this branch's query selects the
// root span's own row directly out of the same table every span lands in
// (WHERE ParentSpanId = ''), so there's no separate "search index" that
// can lag behind ingestion the way Tempo's did — the cleanTempoField
// workaround this replaced simply has nothing to clean.
async function recentTraceList(serviceName, opts = {}) {
  const includeHealthChecks = Boolean(opts.includeHealthChecks);
  // Default behavior (no opts.sinceIso/untilIso) is UNCHANGED from before —
  // "recent" means the last LOOKBACK_SECONDS, same as every existing caller
  // already expects. sinceIso/untilIso are additive, for the two new callers
  // that need to look at an arbitrary window instead of "recent": the traces
  // route's own since/until query params (browsing history, now that
  // retention actually keeps data around — see /api/services/:name/traces),
  // and fetchIncidentContext (jumping straight to the traces around one
  // specific moment, e.g. a fired alert's timestamp).
  const windowClause =
    opts.sinceIso && opts.untilIso
      ? `Timestamp >= parseDateTime64BestEffort(${sqlString(opts.sinceIso)}) AND Timestamp <= parseDateTime64BestEffort(${sqlString(opts.untilIso)})`
      : `Timestamp >= now() - INTERVAL ${LOOKBACK_SECONDS} SECOND`;
  const rows = await queryClickHouse(`
    SELECT
      TraceId,
      Duration,
      ServiceName,
      SpanName,
      SpanAttributes,
      StatusCode,
      toUnixTimestamp64Nano(Timestamp) AS StartTimeUnixNano
    FROM ${CLICKHOUSE_TRACES_TABLE}
    WHERE ${serviceWhereClause(serviceName, opts.instanceIds)}
      AND ${windowClause}
    ORDER BY Duration DESC
    LIMIT 50
  `);
  const all = rows
    .map((t) => ({
      traceId: t.TraceId,
      durationMs: typeof t.Duration !== 'undefined' ? Number(t.Duration) / 1e6 : null,
      rootService: t.ServiceName || serviceName,
      rootOperation: t.SpanName || null,
      // deriveSpanLabel only takes over for non-HTTP root spans (DB/RPC/
      // messaging) — HTTP root spans keep using rootOperation as-is, same
      // value, so nothing downstream that already reads rootOperation
      // (the HTTP_OPERATION_RE filtering below in particular) changes.
      rootOperationLabel: deriveSpanLabel(t.SpanName, t.SpanAttributes) || null,
      // Matches apps/hosted/license-server/clickhouse.js's errorRate threshold (>=500)
      // so "error" means the same thing in the hosted RED-metrics number
      // and this trace list.
      isError: t.StatusCode >= 500,
      startTimeUnixNano: t.StartTimeUnixNano || null,
    }))
    .filter((t) => t.traceId);

  const real = all.filter(
    (t) => t.rootOperation && HTTP_OPERATION_RE.test(t.rootOperation) && !HEALTH_CHECK_OPERATION_RE.test(t.rootOperation)
  );
  const hiddenCount = all.length - real.length;

  // "Show health checks" is now an explicit toggle in the UI rather than an
  // always-on filter — some people want to actually watch /actuator/health
  // polling (e.g. to confirm Docker's HEALTHCHECK is even firing). When it's
  // on, skip the filter entirely and just sort everything.
  if (includeHealthChecks) {
    all.sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0));
    return { traces: all.slice(0, 8), hiddenHealthCheckCount: 0 };
  }

  real.sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0));

  // If filtering left nothing — no real HTTP request spans in the window at
  // all, only health checks and/or background spans — fall back to the
  // unfiltered list rather than showing a flatly empty panel. This is
  // exactly the "only health checks and DB housekeeping, no real API spans
  // yet" case: better to show what's actually there (and let the hidden
  // count above explain what got excluded) than hide everything.
  const traces = real.length > 0 ? real : all.sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0));
  const topTraces = traces.slice(0, 8);

  // Only for the handful actually being returned — see
  // resolveTraceOperationForService's comment for why this is cheap and
  // why it's not applied to the wider candidate pool above.
  await Promise.all(
    topTraces.map(async (t) => {
      if (!t.rootOperation) {
        t.rootOperation = await resolveTraceOperationForService(t.traceId, serviceName);
      }
    })
  );

  return { traces: topTraces, hiddenHealthCheckCount: real.length > 0 ? hiddenCount : 0 };
}

// Full per-span breakdown for one trace, sorted slowest-first. Tempo's
// /api/traces/<id> returned the whole trace as one nested OTLP JSON blob
// (resourceSpans -> scopeSpans -> spans) that had to be flattened; in
// ClickHouse every span is already its own flat row with TraceId as an
// ordinary queryable column, so this is a single SELECT instead of a
// tree-walk — one of the concrete simplifications from this swap, not
// just a like-for-like port. otlpAttr (Tempo's raw-OTLP attribute-array
// unwrapper) has nothing left to do here and was removed with it.
async function fetchTraceDetail(traceId) {
  const rows = await queryClickHouse(`
    SELECT
      SpanId,
      ParentSpanId,
      ServiceName,
      SpanName,
      SpanAttributes,
      StatusCode,
      toUnixTimestamp64Nano(Timestamp) AS StartTimeUnixNano,
      Duration
    FROM ${CLICKHOUSE_TRACES_TABLE}
    WHERE TraceId = ${sqlString(traceId)}
    ORDER BY Timestamp ASC
  `);

  const spans = rows.map((span) => ({
    spanId: span.SpanId,
    parentSpanId: span.ParentSpanId || null,
    service: span.ServiceName || 'unknown-service',
    operation: deriveSpanLabel(span.SpanName, span.SpanAttributes),
    // Surfaced separately from `operation` (which may already be a
    // deriveSpanLabel rewrite) so the waterfall can show a status code
    // badge without re-parsing it back out of a label string.
    httpStatusCode: span.StatusCode || null,
    isError: span.StatusCode >= 500,
    // The raw key/value pairs ClickHouse already returned (see this
    // table's SpanAttributes column) — carried through so the
    // attribute-inspector drawer can show them, same data deriveSpanLabel
    // above already reads from, just not thrown away afterward.
    attributes: span.SpanAttributes || {},
    startNs: BigInt(span.StartTimeUnixNano || 0),
    durationMs: Number(span.Duration) / 1e6, // Duration is nanoseconds
  }));

  if (spans.length === 0) return { traceId, durationMs: null, spans: [] };

  const traceStartNs = spans.reduce((min, s) => (s.startNs < min ? s.startNs : min), spans[0].startNs);
  const traceEndNs = spans.reduce((max, s) => {
    const end = s.startNs + BigInt(Math.round(s.durationMs * 1e6));
    return end > max ? end : max;
  }, traceStartNs);

  const withOffsets = spans
    .map((s) => ({
      spanId: s.spanId,
      parentSpanId: s.parentSpanId,
      service: s.service,
      operation: s.operation,
      // FIX — httpStatusCode/isError/attributes were computed just above
      // and then silently dropped by this second .map(), which only ever
      // copied six fields over. TraceWaterfall.jsx's error pill
      // (`s.isError`/`s.httpStatusCode`) has been reading undefined for
      // every span as a result — never rendering, regardless of the span's
      // actual status. Carried through now, plus attributes (new) for the
      // attribute-inspector drawer.
      httpStatusCode: s.httpStatusCode,
      isError: s.isError,
      attributes: s.attributes,
      offsetMs: Number(s.startNs - traceStartNs) / 1e6,
      durationMs: s.durationMs,
    }))
    .sort((a, b) => b.durationMs - a.durationMs);

  return {
    traceId,
    durationMs: Number(traceEndNs - traceStartNs) / 1e6,
    // Top 15 by duration — the slowest span is index 0, i.e. the direct
    // answer to "what's slow." Full span count kept separately in case the
    // trace has more than that (rare for anything but a very fan-out-heavy
    // request).
    spanCount: withOffsets.length,
    spans: withOffsets.slice(0, 15),
  };
}

// ---- routes --------------------------------------------------------------

// Every container Docker knows about on this host, with each one's watched
// flag and (if set) its check/metrics/otel config. This is "discovery" now
// — see the file header for why it no longer depends on traffic or Beyla.
app.get('/api/services', async (req, res) => {
  try {
    const [containers, state] = [await listContainers(), loadState()];
    const imageByName = new Map(containers.map((c) => [c.name, c.image]));
    const services = containers
      .map((c) => c.name)
      .sort()
      .map((name) => {
        const entry = state.services[name];
        return {
          name,
          image: imageByName.get(name) || null,
          watched: Boolean(entry && entry.watched),
          check: (entry && entry.check) || null,
          metrics: (entry && entry.metrics) || null,
          otel: (entry && entry.otel) || null,
        };
      });
    res.json({ services, otelLanguages: Object.keys(OTEL_LANGUAGES) });
  } catch (err) {
    const message = describeFetchError(err);
    console.error(`[app] /api/services failed: ${message}`);
    res.status(502).json({ error: message });
  }
});

// Flip the watched flag for one service. Instant — just a local state write.
// Starts/stops its manual check (if one is configured) to match.
app.post('/api/services/:name/toggle', (req, res) => {
  const state = loadState();
  const name = req.params.name;
  const entry = getServiceEntry(state, name);
  const turningOn = !entry.watched;

  // No free-tier watched-service cap on self-hosted — unlimited.

  entry.watched = turningOn;
  saveState(state);
  if (entry.watched && entry.check) startCheck(name, entry.check);
  else stopCheck(name);
  res.json({ name, watched: entry.watched, check: entry.check, metrics: entry.metrics, otel: entry.otel });
});

// Clears a service's OWN stored spans, log patterns, and metrics history —
// not the watch config, and not Docker's own logs (this only ever touches
// the ClickHouse tables this app writes to: otel_traces, log_patterns,
// container_metrics — see ensureClickHouseSchema). For the "I un-watched a
// dead service, now let me reclaim the disk it used" case (product backlog
// item #12) — un-watching alone stops new data from arriving but leaves
// everything already stored; this is the explicit, separate "and actually
// delete what's there" action. ClickHouse's ALTER TABLE ... DELETE is a
// mutation, not instant — it's accepted here and runs in the background,
// same as any TTL-driven delete already does, so the response confirms the
// delete was SUBMITTED, not that it's finished.
app.delete('/api/services/:name/data', async (req, res) => {
  const name = req.params.name;
  try {
    await Promise.all([
      queryClickHouse(`ALTER TABLE ${CLICKHOUSE_TRACES_TABLE} DELETE WHERE ServiceName = ${sqlString(name)}`),
      queryClickHouse(`ALTER TABLE ${CLICKHOUSE_LOG_PATTERNS_TABLE} DELETE WHERE ServiceName = ${sqlString(name)}`),
      queryClickHouse(`ALTER TABLE ${CLICKHOUSE_CONTAINER_METRICS_TABLE} DELETE WHERE ServiceName = ${sqlString(name)}`),
    ]);
    res.json({ name, cleared: true });
  } catch (err) {
    console.error(`[app] clear data for ${name} failed:`, err.message);
    res.status(502).json({ error: `could not clear stored data for ${name} right now` });
  }
});

// Set, replace, or clear one service's manual (Kuma-style) health check —
// only needed for a service without its own Docker HEALTHCHECK where
// "container is running" isn't good enough. Body: { type: "http"|"tcp",
// target: string }, or an empty target to clear it.
app.post('/api/services/:name/check', (req, res) => {
  const name = req.params.name;
  const { type, target } = req.body || {};
  const state = loadState();
  const entry = getServiceEntry(state, name);

  if (!target) {
    entry.check = null;
    stopCheck(name);
  } else if (type !== 'http' && type !== 'tcp') {
    return res.status(400).json({ error: 'type must be "http" or "tcp"' });
  } else {
    entry.check = { type, target };
    if (entry.watched) startCheck(name, entry.check);
  }

  saveState(state);
  res.json({ name, check: entry.check });
});

// Turn log-based request metrics on/off for one service. Body: { enabled: bool }.
app.post('/api/services/:name/metrics', (req, res) => {
  const name = req.params.name;
  const { enabled } = req.body || {};
  const state = loadState();
  const entry = getServiceEntry(state, name);
  entry.metrics = enabled ? { enabled: true } : null;
  saveState(state);
  res.json({ name, metrics: entry.metrics });
});

// Turn clustered log-pattern storage on/off for one service. Body:
// { enabled: bool }. Same instant-effect, no-restart-needed pattern as
// /metrics above — reconcileLogIngestion's next tick (a few seconds,
// same cadence as the other background pollers) picks the change up and
// starts/stops the actual tailer. See "Log pattern storage" above for
// what this trades off (real, additive disk usage) before this is ever
// surfaced without the warning LogsPanel.jsx shows before enabling it.
app.post('/api/services/:name/log-storage', (req, res) => {
  const name = req.params.name;
  const { enabled } = req.body || {};
  const state = loadState();
  const entry = getServiceEntry(state, name);
  entry.logStorage = enabled ? { enabled: true } : null;
  saveState(state);
  res.json({ name, logStorage: entry.logStorage });
});

// ---- Per-service alert overrides ----------------------------------------
//
// See effectiveAlertSettingsForService's comment for the model: this is a
// PARTIAL override of the global alertConfig's { enabled, thresholds }
// shape, stored per service. GET returns both the raw override (what's
// actually saved for this service — null fields mean "not overridden,
// inherits the global value") and the resolved `effective` view (what will
// actually be evaluated), since a settings UI showing raw overrides alone
// would leave someone guessing what number is actually in force for
// everything they haven't explicitly overridden.
app.get('/api/services/:name/alert-overrides', (req, res) => {
  const state = loadState();
  const entry = state.services[req.params.name];
  const overrides = (entry && entry.alertOverrides) || null;
  const effective = effectiveAlertSettingsForService(state.alertConfig, entry || {});
  res.json({ overrides, effective });
});

// Partial update, same "send only what's changing" contract as
// POST /api/alerts/config — anything omitted keeps whatever's already
// overridden (or stays un-overridden, inheriting the global value).
// `{ clear: true }` drops every override for this service back to null
// (fully inherit global again) rather than requiring each field to be
// reset to null individually. Threshold values are validated the same way
// the global config's POST handler validates them (clampPercent/clampMs) —
// a stray bad value here shouldn't corrupt state.json any more than it
// would globally.
app.post('/api/services/:name/alert-overrides', (req, res) => {
  const name = req.params.name;
  const body = req.body || {};
  const state = loadState();
  const entry = getServiceEntry(state, name);

  if (body.clear) {
    entry.alertOverrides = null;
    saveState(state);
    res.json({ name, overrides: null, effective: effectiveAlertSettingsForService(state.alertConfig, entry) });
    return;
  }

  const current = entry.alertOverrides || { enabled: {}, thresholds: {} };
  const next = { enabled: { ...current.enabled }, thresholds: { ...current.thresholds } };

  if (body.enabled) {
    for (const key of ['serviceDown', 'cpu', 'memory', 'errorRate', 'latency']) {
      // Explicit null clears just this one enabled-override (back to
      // inheriting whatever the global toggle is), same convention as
      // thresholds below — a per-field "un-override," not a full reset.
      if (body.enabled[key] === null) delete next.enabled[key];
      else if (body.enabled[key] !== undefined) next.enabled[key] = Boolean(body.enabled[key]);
    }
  }
  if (body.thresholds) {
    const t = body.thresholds;
    // For EVERY threshold field: an explicit `null` deletes that one key
    // from this service's override object entirely, so
    // effectiveAlertSettingsForService's spread naturally falls through to
    // the global value again — a real per-field "go back to inheriting,"
    // not a fake number standing in for "unset." A real number gets
    // clamped exactly like the global config's own POST handler clamps it
    // (clampPercent for percent fields, clampMs for the two millisecond/
    // absolute fields), with the CURRENT override (or, if there isn't one
    // yet, the global value) as the fallback for a non-numeric input.
    const globalT = state.alertConfig.thresholds;
    const PERCENT_FIELDS = [
      'cpuWarningPercent',
      'cpuCriticalPercent',
      'memWarningPercent',
      'memCriticalPercent',
      'errorRateWarningPercent',
      'errorRateCriticalPercent',
    ];
    const MS_FIELDS = ['latencyWarningMs', 'latencyCriticalMs', 'memWarningMb', 'memCriticalMb'];
    for (const key of PERCENT_FIELDS) {
      if (t[key] === null) delete next.thresholds[key];
      else if (t[key] !== undefined) next.thresholds[key] = clampPercent(t[key], next.thresholds[key] ?? globalT[key]);
    }
    for (const key of MS_FIELDS) {
      if (t[key] === null) delete next.thresholds[key];
      else if (t[key] !== undefined) next.thresholds[key] = clampMs(t[key], next.thresholds[key] ?? globalT[key]);
    }
  }

  entry.alertOverrides = next;
  saveState(state);
  res.json({ name, overrides: next, effective: effectiveAlertSettingsForService(state.alertConfig, entry) });
});

// Turn full OTel tracing on/off for one service. Body: { enabled: bool,
// language: "java" }. This only records the choice — it does not touch any
// compose file. Use GET .../otel/compose to get the actual override to apply.
app.post('/api/services/:name/otel', (req, res) => {
  const name = req.params.name;
  const { enabled, language } = req.body || {};
  if (enabled && !OTEL_LANGUAGES[language]) {
    return res.status(400).json({ error: `unsupported language "${language}" — supported: ${Object.keys(OTEL_LANGUAGES).join(', ') || '(none yet)'}` });
  }
  const state = loadState();
  const entry = getServiceEntry(state, name);
  entry.otel = enabled ? { enabled: true, language } : null;
  saveState(state);
  res.json({ name, otel: entry.otel });
});

// Best-effort language guess for one service, used to pre-fill (never
// auto-apply) the language dropdown when someone sets up tracing — see
// "Guessing a service's language" above for why this stays a suggestion.
app.get('/api/services/:name/otel/guess', async (req, res) => {
  const name = req.params.name;
  try {
    const containers = await listContainers();
    const container = containers.find((c) => c.name === name);
    if (!container) return res.status(404).json({ error: `no container named "${name}"` });
    const inspect = await inspectContainer(container.id);
    res.json(guessLanguageFromInspect(inspect));
  } catch (err) {
    res.status(502).json({ error: describeFetchError(err) });
  }
});

// Same guess, for every currently-watched service in one round trip — what
// the bulk setup panel uses to pre-fill every row's dropdown at once instead
// of one request per service. Services whose container can't be found or
// inspected just come back with guess: null rather than failing the batch.
app.get('/api/otel/guess-languages', async (req, res) => {
  const state = loadState();
  try {
    const containers = await listContainers();
    const watchedNames = Object.entries(state.services)
      .filter(([, entry]) => entry.watched)
      .map(([svcName]) => svcName);
    const results = {};
    await Promise.all(
      watchedNames.map(async (svcName) => {
        const container = containers.find((c) => c.name === svcName);
        if (!container) {
          results[svcName] = { guess: null, supported: false, reason: 'container not currently running' };
          return;
        }
        try {
          const inspect = await inspectContainer(container.id);
          results[svcName] = guessLanguageFromInspect(inspect);
        } catch (err) {
          results[svcName] = { guess: null, supported: false, reason: describeFetchError(err) };
        }
      })
    );
    res.json({ guesses: results });
  } catch (err) {
    res.status(502).json({ error: describeFetchError(err) });
  }
});

// Resolves the live roster of services that should be in the merged
// override: otel-enabled AND currently watched AND currently running with
// resolvable Compose labels. All three checks matter — this is exactly
// where an earlier version of this only checked the first one, which is
// how a service someone had stopped WATCHING (but never explicitly
// disabled tracing on, e.g. because it belonged to some other project that
// happened to share the Docker host) kept turning up in the generated
// file indefinitely. A service failing any of these checks is just left
// out, not an error — this file is a live snapshot, not a promise that
// nothing changed, so re-running this on every fetch is exactly what makes
// stale entries self-correct without any manual cleanup step.
async function resolveOtelOverrideEntries(state) {
  let containers;
  try {
    containers = await listContainers();
  } catch (err) {
    const wrapped = new Error(describeFetchError(err));
    wrapped.statusCode = 502;
    throw wrapped;
  }
  const entries = [];
  for (const [svcName, entry] of Object.entries(state.services)) {
    if (!entry.watched || !entry.otel || !entry.otel.enabled) continue;
    const container = containers.find((c) => c.name === svcName);
    if (!container || !container.composeService) continue;
    entries.push({ containerName: svcName, composeServiceName: container.composeService, language: entry.otel.language, image: container.image });
  }
  return entries;
}

// Global, not per-service — the merged file's content never actually
// depended on which service you asked from (see resolveOtelOverrideEntries
// above), so keeping these under /api/services/:name/... was pure
// leftover from the old one-file-per-service design and pushed a
// misleading "go into each service to get the setup file" workflow onto
// the UI. There's one tracing setup file for the whole stack; there's one
// place to view/download it.
app.get('/api/otel/compose', async (req, res) => {
  const state = loadState();
  try {
    const entries = await resolveOtelOverrideEntries(state);
    res.json(await generateOtelOverride(entries));
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

// Same generation as above, but returns the raw YAML as a real file
// download (Content-Disposition: attachment) instead of JSON — so the
// browser saves the override directly, no copy-paste-into-a-new-file step
// needed.
app.get('/api/otel/compose/download', async (req, res) => {
  const state = loadState();
  try {
    const entries = await resolveOtelOverrideEntries(state);
    const { filename, yaml } = await generateOtelOverride(entries);
    res.setHeader('Content-Type', 'application/x-yaml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(yaml);
  } catch (err) {
    res.status(err.statusCode || 400).send(err.message);
  }
});

// Status for every watched service: up/down (manual check, else Docker's
// own health/run-state — see dockerHealthSignal), plus, only for services
// that opted in, log-based request metrics and/or trace-derived slow/fresh.
// ---- Tracing preflight check ----------------------------------------------
//
// Reviewer feedback (Reddit, independently raised more than once): when
// eBPF tracing silently captures nothing, this app gave no visible
// explanation — just empty charts, indistinguishable from "no traffic yet."
// The two most common real-world causes, per that feedback and Beyla's own
// docs: (1) the HOST kernel doesn't expose BTF (/sys/kernel/btf/vmlinux) —
// common on some managed/locked-down VPS images and non-standard kernels,
// and Beyla's eBPF probes can't attach without it; (2) the beyla container
// itself failed to start or crashed. This check answers both directly
// instead of leaving an operator to guess from empty charts.
//
// BTF_PATH reads through the SAME kind of narrow, read-only host mount
// already used for docker.sock and /proc above (see docker-compose.yml's
// engine volumes) — /sys/kernel/btf is mounted read-only at /hostsys/kernel/btf
// specifically so this check can run from here without giving `engine`
// anything like beyla's own privileged/pid:host access.
const BTF_PATH = '/hostsys/kernel/btf/vmlinux';
let preflightCache = { checkedAt: null, btfAvailable: null, beylaReachable: null, status: null, message: null };
const PREFLIGHT_CACHE_MS = 30000; // avoid hammering the filesystem/network on every frontend poll

function checkBeylaReachable() {
  return new Promise((resolve) => {
    const req = http.get({ host: BEYLA_HOST, port: 9464, path: '/metrics', timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function runPreflightCheck() {
  let btfAvailable = false;
  try {
    btfAvailable = fs.existsSync(BTF_PATH);
  } catch (_) {
    btfAvailable = false;
  }
  const beylaReachable = await checkBeylaReachable();

  let status = 'ok';
  let message = "Kernel exposes BTF and beyla is reachable — tracing should be fully functional.";
  if (!btfAvailable && !beylaReachable) {
    status = 'error';
    message =
      "beyla isn't reachable, and this host's kernel doesn't expose BTF (/sys/kernel/btf/vmlinux is missing) — eBPF tracing can't work here, so traces will stay empty. Check `docker compose logs beyla`, and ask your host provider whether a BTF-enabled kernel is available.";
  } else if (!btfAvailable) {
    status = 'error';
    message =
      "This host's kernel doesn't expose BTF (/sys/kernel/btf/vmlinux is missing) — beyla's eBPF probes can't attach, so tracing will silently show no data even though every container is otherwise healthy. This is common on some managed VPS images and locked-down kernels; check with your host provider whether a BTF-enabled kernel is available.";
  } else if (!beylaReachable) {
    status = 'error';
    message = "Can't reach beyla's metrics endpoint — it may have failed to start or crashed. Check `docker compose logs beyla`.";
  }

  preflightCache = { checkedAt: new Date().toISOString(), btfAvailable, beylaReachable, status, message };
  return preflightCache;
}

// Cached for PREFLIGHT_CACHE_MS so the frontend can poll this cheaply
// (same polling pattern IncidentPanel/OverviewSummary already use) without
// re-stat'ing /sys or re-hitting beyla's /metrics on every single poll.
app.get('/api/preflight', async (req, res) => {
  const stale =
    !preflightCache.checkedAt || Date.now() - new Date(preflightCache.checkedAt).getTime() > PREFLIGHT_CACHE_MS;
  if (stale) await runPreflightCheck();
  res.json(preflightCache);
});

app.get('/api/status', async (req, res) => {
  const state = loadState();
  const watchedEntries = Object.entries(state.services).filter(([, e]) => e.watched);

  let containers = [];
  let containersError = null;
  try {
    containers = await listContainers();
  } catch (err) {
    containersError = describeFetchError(err);
  }
  const byName = new Map(containers.map((c) => [c.name, c]));

  const results = await Promise.all(
    watchedEntries.map(async ([name, entry]) => {
      const container = byName.get(name) || null;
      const checkEntry = activeChecks.get(name);
      const checkResult = checkEntry ? checkEntry.result : null;

      let up = null;
      let upSource = 'none';
      if (entry.check && checkResult) {
        up = checkResult.up;
        upSource = 'check';
      } else if (entry.check && !checkResult) {
        upSource = 'checking'; // configured, but the first run hasn't completed yet
      } else {
        const docker = dockerHealthSignal(container);
        up = docker.up;
        upSource = docker.source;
      }

      const metrics =
        entry.metrics && entry.metrics.enabled && container
          ? await logMetricsForContainer(container.id)
          : null;
      // Always queried now, regardless of entry.otel.enabled: that flag only
      // tracks the manual full-OTel-agent opt-in (see BulkOtelSetup/
      // TracingPanel), but `beyla` in docker-compose.yml is always-on and can
      // produce real span data for ANY watched container with zero opt-in —
      // gating this query on otel.enabled meant Beyla's traces silently never
      // reached the UI even when Tempo had them (BeylaPanel's own "check this
      // service's trace data above" was a lie until this changed). Cheap
      // either way: traceSignal() itself degrades to a fast no-op result
      // ('no-data') rather than erroring when Tempo has nothing for this name.
      let trace = await traceSignal(name);
      // 'agent' here means "found under the container's own name" — in
      // practice that's the manual OTel agent (or a service that set its
      // own OTEL_SERVICE_NAME), since Beyla never names a span after the
      // container by itself (confirmed against Beyla's own docs — no
      // container-identity attribute outside k8s). Tagged unconditionally
      // whenever this direct lookup finds something, REGARDLESS of
      // entry.otel.enabled — the frontend decides what to do with a
      // same-name hit that shows up before the opt-in flag does (or after
      // it's turned off but stale spans are still in the window).
      if (trace && trace.status !== 'no-data') trace.source = 'agent';
      // Beyla names services after their runtime, not their container (see
      // resolveBeylaServiceName's comment) — so a direct miss doesn't mean
      // there's no data, just that it's filed under a different name. Only
      // worth the extra round trip when the direct query actually came up
      // empty, and only when we have a container to resolve a PID from.
      // Resolved once per container regardless of whether the direct trace
      // lookup above hit — RED metrics come from Beyla's own always-on
      // counters, unrelated to whether this service also has agent-based
      // tracing set up, so this shouldn't be nested inside the "trace was a
      // miss" branch below the way the trace fallback is.
      let beylaName = null;
      let beylaInstanceIds = null;
      if (container) {
        beylaName = await resolveBeylaServiceName(container);
        if (beylaName) beylaInstanceIds = await resolveBeylaInstanceIds(container);
      }

      if ((!trace || trace.status === 'no-data') && beylaName && beylaName !== name) {
        // Instance IDs scope the query to just THIS container's own PIDs —
        // required because Beyla names services after their runtime, and
        // another container running the same runtime (including
        // podotype's own app container, itself Node.js) can share this
        // exact name. Without this, a shared name silently mixes two
        // containers' spans together (root-caused live: podotype's own
        // "GET /api/services/*/traces" dashboard traffic was showing up
        // under a watched Node service's trace list). See
        // traceqlServiceFilter's comment.
        const beylaTrace = await traceSignal(beylaName, beylaInstanceIds);
        if (beylaTrace && beylaTrace.status !== 'no-data') {
          beylaTrace.source = 'beyla';
          trace = beylaTrace;
        }
      }

      // Request rate + error rate — see the "RED metrics" block above for
      // why these come from Beyla's own counters rather than Tempo. Always
      // looked up under the Beyla name (own container name lookups don't
      // apply here — Beyla never names anything after a container, only
      // its runtime), same scoping-by-instance-id reasoning as the trace
      // fallback just above.
      const red = beylaName ? redMetricsForBeylaTarget(beylaName, beylaInstanceIds) : null;

      // CPU/memory — looked up by the container's own id (not its Beyla
      // name; this is plain Docker stats, no runtime-name ambiguity to
      // resolve), from the background poller's cache. null while the
      // first poll cycle hasn't reached this container yet (e.g. just
      // started watching it) rather than blocking this request on a slow
      // Docker stats call.
      const health = container ? containerHealthCache.get(container.id) || null : null;

      // See fetchSpansPerSec/fetchLogsPerSec's own comment for why these
      // are separate from `red` above. Spans are counted under whichever
      // identity actually produced the `trace` signal above (agent's own
      // container name, or Beyla's runtime name + instance ids) so the
      // rate matches what's really being stored for this service, not a
      // name that happens to come up empty. Logs are always counted under
      // the container's own name — log_patterns is filled straight from
      // Docker's log driver, no Beyla runtime-name ambiguity involved —
      // and only queried when this service actually opted into log
      // storage, same gate reconcileLogIngestion itself uses.
      const spanIdentity =
        trace && trace.status !== 'no-data' && trace.source === 'beyla' && beylaName
          ? { svc: beylaName, ids: beylaInstanceIds }
          : { svc: name, ids: null };
      const [spansPerSec, logsPerSec] = await Promise.all([
        trace && trace.status !== 'no-data' ? fetchSpansPerSec(spanIdentity.svc, spanIdentity.ids) : Promise.resolve(null),
        entry.logStorage && entry.logStorage.enabled ? fetchLogsPerSec(name) : Promise.resolve(null),
      ]);
      const ingestion = { spansPerSec, logsPerSec };

      return {
        name,
        found: Boolean(container),
        up,
        upSource,
        check: entry.check,
        checkResponseTimeMs: checkResult ? checkResult.responseTimeMs : null,
        checkError: checkResult && !checkResult.up ? checkResult.error : null,
        metrics,
        otel: entry.otel,
        trace,
        red,
        health,
        ingestion,
      };
    })
  );

  res.json({
    generatedAt: new Date().toISOString(),
    thresholds: { staleAfterSeconds: STALE_AFTER_SECONDS, slowThresholdMs: SLOW_THRESHOLD_MS },
    containersError,
    storage: storageStatus,
    services: results,
  });
});

// What's currently wrong (sustained past the configured sustainChecks) plus
// a bounded log of what fired/resolved recently — see the "Alerts" section
// above for the evaluation logic this just reports on. `channels` tells the
// frontend which notification paths are actually configured AND turned on,
// so the alerts panel can say "in-app only" honestly instead of implying
// Telegram/webhook delivery that was never set up (or was set up but is
// currently switched off).
app.get('/api/alerts', (req, res) => {
  const { sustainChecks, channels } = loadState().alertConfig;
  res.json({
    generatedAt: new Date().toISOString(),
    sustainChecks,
    active: [...activeAlerts.values()],
    history: alertHistory,
    channels: {
      telegram: Boolean(channels.telegram.enabled && channels.telegram.botToken && channels.telegram.chatId),
      webhook: Boolean(channels.webhook.enabled && channels.webhook.url),
      email: Boolean(channels.email.enabled && channels.email.smtpHost && channels.email.smtpUser && channels.email.smtpPassword && channels.email.to),
    },
  });
});

// Full config backing the Alerts settings UI — which of the four triggers
// are on, their thresholds, the sustain window, and each channel's
// enabled+credentials. Returned as-is (including botToken/url) rather than
// masked: this whole app has no login/auth boundary of its own (same as
// every other endpoint here — see this file's own top comment), so there's
// no "which viewer" to hide a secret from that a network-level view of this
// dashboard doesn't already expose.
app.get('/api/alerts/config', (req, res) => {
  res.json(loadState().alertConfig);
});

// Percent fields get clamped to a sane 0-100 range and coerced to a number
// (a stray string from an <input type="number"> that got cleared, or a
// value outside 0-100, would otherwise silently corrupt state.json rather
// than fail the save loudly).
function clampPercent(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

// Same idea as clampPercent, for the latency thresholds — no natural 100 cap
// for milliseconds, so this just guards against a negative or non-numeric
// value corrupting state.json rather than clamping to any specific range.
function clampMs(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, n);
}

// Partial update — send just the fields changing (e.g. one threshold, or
// one channel's credentials); anything omitted keeps its current saved
// value. Merges onto the CURRENT alertConfig (not just the defaults) so
// flipping one toggle in the UI never clobbers everything else already set.
app.post('/api/alerts/config', (req, res) => {
  const state = loadState();
  const current = state.alertConfig;
  const body = req.body || {};

  const next = {
    enabled: { ...current.enabled, ...(body.enabled || {}) },
    thresholds: { ...current.thresholds },
    sustainChecks: current.sustainChecks,
    channels: {
      telegram: { ...current.channels.telegram },
      webhook: { ...current.channels.webhook },
      email: { ...current.channels.email },
    },
  };

  if (body.thresholds) {
    const t = body.thresholds;
    if (t.cpuWarningPercent !== undefined) next.thresholds.cpuWarningPercent = clampPercent(t.cpuWarningPercent, current.thresholds.cpuWarningPercent);
    if (t.cpuCriticalPercent !== undefined) next.thresholds.cpuCriticalPercent = clampPercent(t.cpuCriticalPercent, current.thresholds.cpuCriticalPercent);
    if (t.memWarningPercent !== undefined) next.thresholds.memWarningPercent = clampPercent(t.memWarningPercent, current.thresholds.memWarningPercent);
    if (t.memCriticalPercent !== undefined) next.thresholds.memCriticalPercent = clampPercent(t.memCriticalPercent, current.thresholds.memCriticalPercent);
    if (t.errorRateWarningPercent !== undefined)
      next.thresholds.errorRateWarningPercent = clampPercent(t.errorRateWarningPercent, current.thresholds.errorRateWarningPercent);
    if (t.errorRateCriticalPercent !== undefined)
      next.thresholds.errorRateCriticalPercent = clampPercent(t.errorRateCriticalPercent, current.thresholds.errorRateCriticalPercent);
    if (t.latencyWarningMs !== undefined) next.thresholds.latencyWarningMs = clampMs(t.latencyWarningMs, current.thresholds.latencyWarningMs);
    if (t.latencyCriticalMs !== undefined) next.thresholds.latencyCriticalMs = clampMs(t.latencyCriticalMs, current.thresholds.latencyCriticalMs);
  }
  if (body.sustainChecks !== undefined) {
    const n = parseInt(body.sustainChecks, 10);
    if (Number.isFinite(n) && n >= 1) next.sustainChecks = n;
  }
  if (body.channels && body.channels.telegram) {
    const t = body.channels.telegram;
    if (t.enabled !== undefined) next.channels.telegram.enabled = Boolean(t.enabled);
    if (t.botToken !== undefined) next.channels.telegram.botToken = String(t.botToken).trim();
    if (t.chatId !== undefined) next.channels.telegram.chatId = String(t.chatId).trim();
  }
  if (body.channels && body.channels.webhook) {
    const w = body.channels.webhook;
    if (w.enabled !== undefined) next.channels.webhook.enabled = Boolean(w.enabled);
    if (w.url !== undefined) next.channels.webhook.url = String(w.url).trim();
  }
  if (body.channels && body.channels.email) {
    const e = body.channels.email;
    if (e.enabled !== undefined) next.channels.email.enabled = Boolean(e.enabled);
    if (e.smtpHost !== undefined) next.channels.email.smtpHost = String(e.smtpHost).trim();
    if (e.smtpPort !== undefined) {
      const n = parseInt(e.smtpPort, 10);
      if (Number.isFinite(n) && n > 0) next.channels.email.smtpPort = n;
    }
    if (e.smtpUser !== undefined) next.channels.email.smtpUser = String(e.smtpUser).trim();
    if (e.smtpPassword !== undefined) next.channels.email.smtpPassword = String(e.smtpPassword).trim();
    if (e.to !== undefined) next.channels.email.to = String(e.to).trim();
  }

  state.alertConfig = next;
  saveState(state);
  res.json(next);
});

// Sends one real test message through whichever channel(s) the request asks
// for, using WHATEVER credentials are in the request body if provided
// (letting someone test a bot token/webhook URL before hitting Save), or
// the currently-saved ones otherwise — and reports each channel's actual
// pass/fail back, rather than the fire-and-forget path evaluateAlertCondition
// itself uses for real alerts. This is what turns "I typed in a token, I
// hope it's right" into "I typed in a token, and a message actually
// arrived" — the same verification bar this project has held every other
// fix on this branch to.
app.post('/api/alerts/test', async (req, res) => {
  const saved = loadState().alertConfig.channels;
  const body = req.body || {};
  const text = '🔔 podotype test alert — if you can see this, this channel is wired up correctly.';

  const results = {};
  const wantTelegram = body.channel === 'telegram' || !body.channel;
  const wantWebhook = body.channel === 'webhook' || !body.channel;
  const wantEmail = body.channel === 'email' || !body.channel;

  if (wantTelegram) {
    const cfg = body.telegram ? { enabled: true, ...body.telegram } : saved.telegram;
    results.telegram = await sendTelegramMessage(text, cfg);
  }
  if (wantWebhook) {
    const cfg = body.webhook ? { enabled: true, ...body.webhook } : saved.webhook;
    results.webhook = await sendWebhookNotification(text, cfg);
  }
  if (wantEmail) {
    const cfg = body.email ? { enabled: true, ...body.email } : saved.email;
    results.email = await sendEmailNotification(text, text, cfg);
  }

  res.json(results);
});

// ---- Trace retention settings ------------------------------------------
//
// Was env-var-only (CLICKHOUSE_TRACE_TTL_HOURS, fixed at container start) —
// this project's own explicit ask was to let someone pick 7 days, 30 days,
// or whatever they want from the UI instead of editing docker-compose.yml,
// and be warned about the space trade-off rather than blocked by it: they
// stay free to pick a large value on purpose. See applyRetentionTtl/
// materializeRetentionTtl/estimateDailyTraceBytes above for the actual
// ClickHouse mechanics this rests on.
const RETENTION_MIN_HOURS = 1;
// 5 years is a sanity ceiling against a fat-fingered value (typing "87600"
// meaning hours but landing on a decade by accident), not a real policy
// limit — someone who genuinely wants years of retention can still get
// there, just not by an obvious typo.
const RETENTION_MAX_HOURS = 24 * 365 * 5;

// hours -> current config plus a REAL (not guessed) daily-volume estimate,
// straight from ClickHouse's own system.parts — see
// estimateDailyTraceBytes's own comment for why this is trustworthy. The
// hours value itself always comes back even if the ClickHouse query fails
// (e.g. ClickHouse briefly unreachable), since it's read from local
// state.json, not from ClickHouse.
// Manual cost override (backlog item #15) — GET/POST/DELETE for the
// UsageStats.jsx "Est. host cost" tile's edit affordance. See
// mergeCostOverride's own comment for why this exists: the auto-estimate
// from detected CPU/RAM can't know the actual provider/instance pricing,
// only someone who pays the bill does.
app.get('/api/cost-override', (req, res) => {
  res.json({ override: loadState().costOverride });
});

app.post('/api/cost-override', (req, res) => {
  const body = req.body || {};
  const monthlyUsd = Number(body.monthlyUsd);
  if (!Number.isFinite(monthlyUsd) || monthlyUsd < 0) {
    return res.status(400).json({ error: 'monthlyUsd must be a non-negative number' });
  }
  const state = loadState();
  state.costOverride = mergeCostOverride({
    monthlyUsd,
    instanceLabel: typeof body.instanceLabel === 'string' ? body.instanceLabel : null,
  });
  saveState(state);
  res.json({ override: state.costOverride });
});

app.delete('/api/cost-override', (req, res) => {
  const state = loadState();
  state.costOverride = null;
  saveState(state);
  res.json({ override: null });
});

app.get('/api/retention/config', async (req, res) => {
  const hours = loadState().retention.hours;
  try {
    const { dailyBytesEstimate, sampleDays } = await estimateDailyTraceBytes();
    res.json({ hours, dailyBytesEstimate, sampleDays, estimateError: null });
  } catch (err) {
    res.json({ hours, dailyBytesEstimate: null, sampleDays: 0, estimateError: describeFetchError(err) });
  }
});

// Saving always applies the new TTL (cheap — just updates ClickHouse's
// metadata for future merges). `reclaimNow: true` additionally runs
// MATERIALIZE TTL, which is real I/O work rewriting parts — only done when
// explicitly asked (the settings UI's own "reclaim space now" checkbox),
// never bundled silently into every save.
app.post('/api/retention/config', async (req, res) => {
  const body = req.body || {};
  const hoursRaw = Number(body.hours);
  if (!Number.isFinite(hoursRaw) || hoursRaw < RETENTION_MIN_HOURS || hoursRaw > RETENTION_MAX_HOURS) {
    res.status(400).json({ error: `hours must be between ${RETENTION_MIN_HOURS} and ${RETENTION_MAX_HOURS}` });
    return;
  }
  const hours = Math.round(hoursRaw);

  const state = loadState();
  state.retention = { hours };
  saveState(state);

  try {
    await applyRetentionTtl(hours);
  } catch (err) {
    // Saved to state.json either way — state.json is the source of truth
    // for what the person WANTS, and the startup retry (see this file's
    // "startup" section) will apply it against ClickHouse the next time
    // the container restarts even if this particular call failed (e.g.
    // ClickHouse mid-restart right now).
    res.status(502).json({ error: `Saved, but ClickHouse rejected the TTL change: ${describeFetchError(err)}`, hours });
    return;
  }

  let reclaimed = false;
  let reclaimError = null;
  if (body.reclaimNow) {
    try {
      await materializeRetentionTtl();
      reclaimed = true;
    } catch (err) {
      reclaimError = describeFetchError(err);
    }
  }

  res.json({ hours, reclaimed, reclaimError });
});

// Same shape as GET/POST /api/retention/config above, against the
// log_patterns table instead — see mergeLogRetentionConfig's comment for
// why this is a separate setting rather than sharing trace retention's.
app.get('/api/log-retention/config', async (req, res) => {
  const hours = loadState().logRetention.hours;
  try {
    const { dailyBytesEstimate, sampleDays } = await estimateDailyLogPatternBytes();
    res.json({ hours, dailyBytesEstimate, sampleDays, estimateError: null });
  } catch (err) {
    res.json({ hours, dailyBytesEstimate: null, sampleDays: 0, estimateError: describeFetchError(err) });
  }
});

app.post('/api/log-retention/config', async (req, res) => {
  const body = req.body || {};
  const hoursRaw = Number(body.hours);
  if (!Number.isFinite(hoursRaw) || hoursRaw < RETENTION_MIN_HOURS || hoursRaw > RETENTION_MAX_HOURS) {
    res.status(400).json({ error: `hours must be between ${RETENTION_MIN_HOURS} and ${RETENTION_MAX_HOURS}` });
    return;
  }
  const hours = Math.round(hoursRaw);

  const state = loadState();
  state.logRetention = { hours };
  saveState(state);

  try {
    await applyLogPatternRetentionTtl(hours);
  } catch (err) {
    res.status(502).json({ error: `Saved, but ClickHouse rejected the TTL change: ${describeFetchError(err)}`, hours });
    return;
  }

  let reclaimed = false;
  let reclaimError = null;
  if (body.reclaimNow) {
    try {
      await materializeLogPatternRetentionTtl();
      reclaimed = true;
    } catch (err) {
      reclaimError = describeFetchError(err);
    }
  }

  res.json({ hours, reclaimed, reclaimError });
});

// History charts for one watched service — CPU%, memory (%/bytes), network
// I/O, disk I/O (all from containerStatsHistory, Docker's own stats API) and
// request-rate/error-rate (from redMetricsHistory, Beyla's Prometheus
// counters), plus restart count and uptime from the latest containerHealthCache
// reading. Deliberately its own on-demand endpoint rather than folded into
// /api/status: /api/status is polled every 5s for EVERY watched service just
// to answer "up or down", and shipping five history arrays per service on
// every one of those polls would multiply that payload for data only worth
// fetching while a service's panel is actually expanded — same "fetch on
// demand when the panel opens" shape TraceExplorer already uses for its own
// per-service trace list.
// Writes one row per currently-watched, currently-resolvable service into
// CLICKHOUSE_CONTAINER_METRICS_TABLE — see that table's own comment for why.
// Deliberately best-effort and silent on most failure paths (no container
// found, no health/RED data yet): a service that was just added, or is
// between polls, just doesn't get a row this cycle rather than writing a
// misleading all-zero one.
async function insertContainerMetricsRows(rows) {
  if (!rows || rows.length === 0) return;
  const insertSql = `INSERT INTO ${CLICKHOUSE_CONTAINER_METRICS_TABLE} FORMAT JSONEachRow`;
  const url = `${CLICKHOUSE_URL}/?database=${encodeURIComponent(CLICKHOUSE_DATABASE)}&query=${encodeURIComponent(insertSql)}`;
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  const res = await fetch(url, { method: 'POST', body });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ClickHouse insert failed: ${res.status} ${text.slice(0, 300)}`);
  }
}

async function persistContainerMetricsSnapshot() {
  const state = loadState();
  const watchedNames = Object.entries(state.services)
    .filter(([, e]) => e.watched)
    .map(([n]) => n);
  if (watchedNames.length === 0) return;
  let containers;
  try {
    containers = await listContainers();
  } catch {
    return; // Docker unreachable this cycle — skip, same as pollContainerHealth's own convention
  }
  const nowIso = new Date().toISOString();
  const rows = [];
  for (const name of watchedNames) {
    const container = containers.find((c) => c.name === name) || null;
    if (!container) continue;
    const health = containerHealthCache.get(container.id) || null;
    const beylaName = resolveBeylaServiceName(container);
    const instanceIds = beylaName ? resolveBeylaInstanceIds(container) : null;
    const red = beylaName ? redMetricsForBeylaTarget(beylaName, instanceIds) : null;
    if (!health && !red) continue; // nothing real to record yet for this service
    rows.push({
      Timestamp: nowIso,
      ServiceName: name,
      CpuPercent: health && health.cpuPercent !== null ? health.cpuPercent : 0,
      MemPercent: health && health.memPercent !== null ? health.memPercent : 0,
      MemUsageBytes: health && health.memUsageBytes !== null ? health.memUsageBytes : 0,
      RequestsPerSec: red ? red.requestsPerSec : 0,
      ErrorRate: red ? red.errorRate : 0,
    });
  }
  if (rows.length === 0) return;
  try {
    await insertContainerMetricsRows(rows);
  } catch (err) {
    console.warn(`[metrics-history] failed to persist snapshot: ${err.message}`);
  }
}

// Historical (ClickHouse-backed) counterpart to the in-memory series
// GET /api/services/:name/metrics-history already returns — that endpoint's
// contract is left completely alone (still just the live ~1hr window from
// containerStatsHistory/redMetricsHistory) so nothing depending on its exact
// shape today breaks. This is a SEPARATE endpoint for the new capability:
// an arbitrary look-back window, sourced from CLICKHOUSE_CONTAINER_METRICS_TABLE,
// for whenever a person wants to see further back than the live charts go.
async function containerMetricsRange(serviceName, sinceIso, untilIso) {
  const rows = await queryClickHouse(`
    SELECT
      toUnixTimestamp64Milli(Timestamp) AS t,
      CpuPercent, MemPercent, MemUsageBytes, RequestsPerSec, ErrorRate
    FROM ${CLICKHOUSE_CONTAINER_METRICS_TABLE}
    WHERE ServiceName = ${sqlString(serviceName)}
      AND Timestamp >= parseDateTime64BestEffort(${sqlString(sinceIso)})
      AND Timestamp <= parseDateTime64BestEffort(${sqlString(untilIso)})
    ORDER BY Timestamp ASC
    LIMIT 10000
  `);
  return rows.map((r) => ({
    t: Number(r.t),
    cpuPercent: r.CpuPercent,
    memPercent: r.MemPercent,
    memUsageBytes: Number(r.MemUsageBytes),
    requestsPerSec: r.RequestsPerSec,
    errorRate: r.ErrorRate,
  }));
}

app.get('/api/services/:name/metrics-history/range', async (req, res) => {
  const { sinceIso, untilIso } = parseTimeRangeQuery(req.query);
  if (!sinceIso || !untilIso) {
    res.status(400).json({ error: 'both `since` and `until` are required (ISO timestamps, since < until)' });
    return;
  }
  try {
    const points = await containerMetricsRange(req.params.name, sinceIso, untilIso);
    const state = loadState();
    const deployMarkers = (state.deployMarkers || [])
      .filter((m) => m.service === req.params.name && Date.parse(m.at) >= Date.parse(sinceIso) && Date.parse(m.at) <= Date.parse(untilIso))
      .map((m) => ({ at: m.at, t: Date.parse(m.at) }));
    res.json({ since: sinceIso, until: untilIso, points, deployMarkers });
  } catch (err) {
    res.status(502).json({ error: describeFetchError(err) });
  }
});

app.get('/api/services/:name/metrics-history', async (req, res) => {
  const name = req.params.name;
  let containers = [];
  try {
    containers = await listContainers();
  } catch (err) {
    return res.status(502).json({ error: describeFetchError(err) });
  }
  const container = containers.find((c) => c.name === name) || null;
  if (!container) {
    return res.json({
      found: false,
      historyPoints: METRICS_HISTORY_POINTS,
      cpu: [],
      memory: [],
      network: [],
      disk: [],
      requests: [],
      latency: [],
      restartCount: null,
      lastExitReason: null,
      uptimeSeconds: null,
      memLimitBytes: null,
    });
  }

  const beylaName = resolveBeylaServiceName(container);
  const instanceIds = beylaName ? resolveBeylaInstanceIds(container) : null;
  const ids = instanceIds && instanceIds.size > 0 ? [...instanceIds] : [''];

  // Merge across every instance id this container is known to have used
  // (normally just one) — mirrors redMetricsForBeylaTarget's own scoping,
  // just summed per-timestamp instead of collapsed to a single current
  // value.
  let requests = [];
  if (beylaName) {
    const byTime = new Map(); // t -> { rps, errWeighted }
    for (const id of ids) {
      const hist = redMetricsHistory.get(`${beylaName}|${id}`) || [];
      for (const point of hist) {
        const acc = byTime.get(point.t) || { rps: 0, errWeighted: 0 };
        acc.rps += point.requestsPerSec;
        acc.errWeighted += point.errorRate * point.requestsPerSec;
        byTime.set(point.t, acc);
      }
    }
    requests = [...byTime.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, acc]) => ({ t, requestsPerSec: acc.rps, errorRate: acc.rps > 0 ? acc.errWeighted / acc.rps : 0 }));
  }

  const health = containerHealthCache.get(container.id) || null;
  const history = containerStatsHistory.get(container.id) || [];

  // Deploy markers within whatever window this in-memory history actually
  // covers, so a chart can draw a vertical line at "this is when the image
  // changed" right alongside the CPU/memory/request-rate series it's already
  // rendering — additive field, nothing above this changes shape.
  const earliestMs = history.length > 0 ? history[0].t : Date.now() - METRICS_HISTORY_POINTS * CONTAINER_STATS_POLL_INTERVAL_MS;
  const state = loadState();
  const deployMarkers = (state.deployMarkers || [])
    .filter((m) => m.service === name && Date.parse(m.at) >= earliestMs)
    .map((m) => ({ at: m.at, t: Date.parse(m.at) }));

  res.json({
    found: true,
    historyPoints: METRICS_HISTORY_POINTS,
    cpu: history.map((p) => ({ t: p.t, value: p.cpuPercent })),
    memory: history.map((p) => ({ t: p.t, percent: p.memPercent, bytes: p.memUsageBytes })),
    network: history.map((p) => ({ t: p.t, rxBps: p.netRxRateBps, txBps: p.netTxRateBps })),
    disk: history.map((p) => ({ t: p.t, readBps: p.blkReadRateBps, writeBps: p.blkWriteRateBps })),
    requests,
    // p95 (and p50/p99 alongside it) sampled every ALERT_EVAL_INTERVAL_MS by
    // evaluateAlerts — see latencyHistory's own declaration. Keyed by this
    // same canonical `name`, not the Beyla runtime name `requests` above is
    // keyed by, so this is a direct Map lookup rather than a merge.
    latency: latencyHistory.get(name) || [],
    deployMarkers,
    restartCount: health ? health.restartCount : null,
    lastExitReason: health ? health.lastExitReason : null,
    uptimeSeconds: health ? health.uptimeSeconds : null,
    memLimitBytes: health ? health.memLimitBytes : null,
  });
});

// ---- Service map: who calls whom ---------------------------------------
//
// Built entirely from spans already sitting in ClickHouse — no new
// collection, no new container. The Kind values confirmed live while
// fixing the "only health checks" bug (see serviceWhereClause's own
// comment above) are what make this possible: Kind=3 is a service's own
// OUTBOUND call to a downstream neighbor, and whichever span that call's
// ParentSpanId points at — regardless of which service reports it — is the
// other end of that edge. A self-join on TraceId+SpanId/ParentSpanId turns
// that parent/child relationship straight into a caller->callee edge,
// without this file needing to track topology anywhere itself.
//
// Nodes are ClickHouse's own ServiceName values (Beyla's runtime-derived
// names, or a manual OTel agent's — see "Beyla name resolution" above for
// why these often differ from a container's own name), NOT podotype's
// watched-service list: a downstream dependency nobody explicitly added to
// "watched" still shows up here, since Beyla is watching the whole host
// regardless — the same "correlate from what's actually observed, don't
// require an opt-in" model this project already applies to discovery
// itself. Known limitation, not yet addressed: this doesn't exclude
// Docker-healthcheck traffic the way recentTraceList does for a single
// service's trace list, so a service that's only ever healthchecked (no
// real callers) still appears as an isolated node with a nonzero request
// count — fine for a first version, worth revisiting if it turns out noisy
// in practice.
// TCP-connection-based service-map edges (fix for the trace-correlation
// bug documented below fetchServiceMap) — reads Beyla's own network-flow
// metrics (see apps/shared/beyla/config.yml's `network: enable: true`),
// resolves each flow's src/dst IP back to a container name via Docker's
// own container list, and aggregates into (from, to) edges the same
// shape fetchServiceMap's trace-based edges already use. This is
// immune to the trace-ID-collision failure mode: it never looks at a
// TraceId or ParentSpanId at all, only real observed TCP connections —
// the same mechanism Coroot's own node-agent uses.
//
// Deliberately forgiving about the exact metric/label names (same
// philosophy isRequestDurationCountMetric already documents) — this
// wasn't confirmed against a live scrape when written. GET
// /api/debug/beyla-metrics dumps the raw text to check the real names
// after deploying; NETWORK_FLOW_METRIC_NAME_RE below is the one place to
// adjust if they differ.
const NETWORK_FLOW_METRIC_NAME_RE = /^beyla_network_flow_(bytes|packets)/;

async function fetchNetworkFlowEdges() {
  let text;
  try {
    const res = await fetch(BEYLA_METRICS_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    // Same "leave existing data alone, don't blank the map" philosophy as
    // pollBeylaRedMetrics — an empty array here just means
    // fetchServiceMap falls back to trace-only edges for this request,
    // not that the map goes empty.
    return { edges: [], error: err.message };
  }

  const parsed = parsePrometheusMetricsText(text).filter((p) => NETWORK_FLOW_METRIC_NAME_RE.test(p.name));
  if (parsed.length === 0) {
    return { edges: [], error: null };
  }

  let containers;
  try {
    containers = await listContainers();
  } catch (err) {
    return { edges: [], error: `listContainers failed: ${err.message}` };
  }
  const ipToName = new Map();
  for (const c of containers) {
    for (const ip of c.ipAddresses || []) ipToName.set(ip, c.name);
  }

  // key `${from}|${to}` -> aggregated totals. Undirected de-dup is
  // deliberately NOT done here — src/dst on a captured TCP flow is the
  // connection's actual initiator/acceptor (same directional convention
  // Coroot's own service map draws), so from!=to pairs in both directions
  // are kept as separate, meaningful edges rather than merged.
  const byPair = new Map();
  let resolvedCount = 0;
  for (const { labels, value } of parsed) {
    const srcIp = firstLabel(labels, ['src_address', 'src_ip']);
    const dstIp = firstLabel(labels, ['dst_address', 'dst_ip']);
    if (!srcIp || !dstIp) continue;
    const from = ipToName.get(srcIp);
    const to = ipToName.get(dstIp);
    // Only keep flows where BOTH ends resolve to a container this engine
    // knows about — a flow to some external IP (an upstream API, DNS,
    // whatever) isn't a service-to-service edge this map can draw
    // anything useful from.
    if (!from || !to || from === to) continue;
    resolvedCount += 1;
    const key = `${from}|${to}`;
    const acc = byPair.get(key) || { from, to, bytesTotal: 0, flowSamples: 0 };
    acc.bytesTotal += value;
    acc.flowSamples += 1;
    byPair.set(key, acc);
  }
  console.warn(
    `[network-map] ${parsed.length} flow metric lines, ${resolvedCount} resolved to a known container pair, ${byPair.size} distinct edges`
  );
  return { edges: [...byPair.values()], error: null };
}

async function fetchServiceMap() {
  const [edgeRows, nodeRows] = await Promise.all([
    queryClickHouse(`
      SELECT
        caller.ServiceName AS callerService,
        callee.ServiceName AS calleeService,
        count() AS callCount,
        quantile(0.95)(callee.Duration) / 1e6 AS p95Ms
      FROM ${CLICKHOUSE_TRACES_TABLE} AS caller
      INNER JOIN ${CLICKHOUSE_TRACES_TABLE} AS callee
        ON caller.TraceId = callee.TraceId AND caller.SpanId = callee.ParentSpanId
      WHERE caller.Kind = 3
        AND callee.ServiceName != caller.ServiceName
        AND caller.Timestamp >= now() - INTERVAL ${LOOKBACK_SECONDS} SECOND
        AND callee.Timestamp >= now() - INTERVAL ${LOOKBACK_SECONDS} SECOND
      GROUP BY callerService, calleeService
      ORDER BY callCount DESC
      LIMIT 200
    `),
    queryClickHouse(`
      SELECT ServiceName, count() AS requestCount, quantile(0.95)(Duration) / 1e6 AS p95Ms
      FROM ${CLICKHOUSE_TRACES_TABLE}
      WHERE Kind = 2 AND Timestamp >= now() - INTERVAL ${LOOKBACK_SECONDS} SECOND
      GROUP BY ServiceName
    `),
  ]);

  const nodesByName = new Map();
  for (const row of nodeRows) {
    const p95Ms = row.p95Ms !== null && row.p95Ms !== undefined ? Number(row.p95Ms) : null;
    nodesByName.set(row.ServiceName, {
      name: row.ServiceName,
      requestCount: Number(row.requestCount),
      p95Ms,
      slow: p95Ms !== null && p95Ms > SLOW_THRESHOLD_MS,
    });
  }

  // Trace-based edges, keyed the same way the network-flow ones are below
  // (`from|to`) so the two sources can be merged by pair instead of two
  // parallel, possibly-conflicting edge lists.
  const traceEdgesByPair = new Map();
  for (const row of edgeRows) {
    // Make sure every endpoint of every edge has a node entry, even a
    // caller/callee that never showed up as a Kind=2 "server" span itself
    // (e.g. a load generator that only ever originates calls and never
    // receives any).
    for (const name of [row.callerService, row.calleeService]) {
      if (!nodesByName.has(name)) nodesByName.set(name, { name, requestCount: 0, p95Ms: null, slow: false });
    }
    const p95Ms = row.p95Ms !== null && row.p95Ms !== undefined ? Number(row.p95Ms) : null;
    traceEdgesByPair.set(`${row.callerService}|${row.calleeService}`, {
      from: row.callerService,
      to: row.calleeService,
      callCount: Number(row.callCount),
      p95Ms,
    });
  }

  // Network-flow edges (real TCP connections — see fetchNetworkFlowEdges'
  // own comment for why this exists: it's immune to the trace-ID
  // collision that can fabricate an edge between services that never
  // actually called each other). This is the SOURCE OF TRUTH for which
  // edges exist whenever it has data; trace data — when it happens to
  // agree on the same pair — is what supplies the call-count/p95 detail a
  // raw byte count can't. A trace-only edge (no matching network flow —
  // e.g. Beyla's network capture hasn't seen it yet this window, or
  // network metrics failed to scrape) is still shown, just marked
  // 'trace-only' rather than silently dropped, since a transient scrape
  // miss shouldn't make a real edge disappear.
  const { edges: networkEdges, error: networkError } = await fetchNetworkFlowEdges();

  const edges = [];
  const seenPairs = new Set();
  for (const ne of networkEdges) {
    const key = `${ne.from}|${ne.to}`;
    seenPairs.add(key);
    for (const name of [ne.from, ne.to]) {
      if (!nodesByName.has(name)) nodesByName.set(name, { name, requestCount: 0, p95Ms: null, slow: false });
    }
    const traceMatch = traceEdgesByPair.get(key);
    edges.push({
      from: ne.from,
      to: ne.to,
      callCount: traceMatch ? traceMatch.callCount : null,
      p95Ms: traceMatch ? traceMatch.p95Ms : null,
      bytesTotal: ne.bytesTotal,
      source: traceMatch ? 'network+trace' : 'network',
    });
  }
  // Whatever trace-only found that the network scrape didn't corroborate
  // this round — kept, not dropped, per the comment above.
  for (const [key, te] of traceEdgesByPair) {
    if (seenPairs.has(key)) continue;
    edges.push({ ...te, bytesTotal: null, source: 'trace-only' });
  }

  return { nodes: [...nodesByName.values()], edges, networkMetricsError: networkError };
}

app.get('/api/service-map', async (req, res) => {
  try {
    const map = await fetchServiceMap();
    res.json({ generatedAt: new Date().toISOString(), lookbackSeconds: LOOKBACK_SECONDS, ...map });
  } catch (err) {
    res.status(502).json({ error: describeFetchError(err) });
  }
});

// Recent traces for a service that's opted into full tracing, slowest
// first — the shortlist the tracing panel's expanded view picks from.
//
// ?since=<ISO>&until=<ISO> (both required together, otherwise ignored)
// switches this from "recent" (last LOOKBACK_SECONDS) to an arbitrary
// historical window — added so that data ClickHouse is already retaining
// (see /api/retention/config) actually becomes something a person can look
// BACK at, not just a 5-minute live view. Bounded to whatever retention.hours
// currently is: asking for a window further back than that would just
// return nothing (ClickHouse's TTL has already dropped it), so there's no
// separate validation needed here beyond that natural limit.
// ---- "Possible cause" — the recurring Reddit ask for depth beyond
// "this service is slow" --------------------------------------------------
//
// Multiple reviewers raised a version of the same gap: eBPF shows THAT a
// service is slow or erroring, not WHY. The data to answer "why", at
// least a reasonable first guess, was already sitting in the same spans
// table fetchTraceDetail already queries — this just reads it with a
// different question in mind. Zero new instrumentation, zero new
// ClickHouse schema: fetchTraceDetail already returns each trace's spans
// SORTED SLOWEST-FIRST, so spans[0] IS the direct answer to "what ate the
// time" for whichever trace this runs against.
//
// Deliberately framed as a GUESS, never a diagnosis: this is correlation
// (which span was slow/erroring) not causation (why it was slow/erroring)
// — a downstream call can be slow because of the caller's own request
// shape, not the callee's fault. Every message below says "possible" or
// reads as an observation, not a verdict, and the API response itself is
// tagged confidence: 'possible' so nothing downstream can forget that and
// present it as confirmed.
function classifySpanAttributes(attributes) {
  const attrs = attributes || {};
  if (attrs['db.statement'] || attrs['db.system']) {
    return { category: 'db', detail: attrs['db.statement'] || attrs['db.system'] || null };
  }
  if (attrs['rpc.method'] || attrs['rpc.system']) {
    return { category: 'rpc', detail: attrs['rpc.method'] || null };
  }
  if (attrs['http.route'] || attrs['http.method'] || attrs['http.url']) {
    return { category: 'http', detail: attrs['http.route'] || attrs['http.url'] || null };
  }
  return { category: 'other', detail: null };
}

// serviceName is whichever name this trace was QUERIED under (container
// name, or the Beyla-resolved runtime name — see the fallback dance in
// /api/services/:name/traces right below this) — used only to tell "the
// slow part was THIS service's own work" apart from "the slow part was a
// call to someone else."
function buildPossibleCause(serviceName, traceDetail) {
  if (!traceDetail || !traceDetail.spans || traceDetail.spans.length === 0) return null;

  const spans = traceDetail.spans; // already sorted slowest-first (see fetchTraceDetail)
  const totalMs = traceDetail.durationMs || null;
  const slowest = spans[0];
  const shareOf = (ms) => (totalMs && totalMs > 0 ? Math.round((ms / totalMs) * 100) : null);

  // An error is a more useful "why" than mere slowness when one exists —
  // but only promote it over the slowest span if it's actually a
  // meaningful chunk of the trace, not a 2ms error buried alongside a
  // 900ms slow span somewhere else that has nothing to do with it.
  const erroring = spans.find((s) => s.isError);
  const culprit = erroring && erroring.durationMs >= slowest.durationMs * 0.3 ? erroring : slowest;
  const culpritShare = shareOf(culprit.durationMs);
  const { category, detail } = classifySpanAttributes(culprit.attributes);
  const sameService = culprit.service === serviceName;

  let message;
  let nextStep;

  if (culprit.isError) {
    if (sameService) {
      message = `${Math.round(culprit.durationMs)}ms went into ${serviceName}'s own "${culprit.operation}" span, which returned an error (status ${culprit.httpStatusCode || 'unknown'}).`;
      nextStep = `Check ${serviceName}'s own logs around this request — the error originated here, not in a downstream call.`;
    } else {
      message = `A call from ${serviceName} to ${culprit.service} ("${culprit.operation}") came back with an error (status ${culprit.httpStatusCode || 'unknown'})${culpritShare !== null ? ` and accounted for ${culpritShare}% of this request's time` : ''}.`;
      nextStep = `Worth checking ${culprit.service}'s own logs and health around this time — it's the one returning the error.`;
    }
  } else if (category === 'db') {
    message = sameService
      ? `${Math.round(culprit.durationMs)}ms${culpritShare !== null ? ` (${culpritShare}% of the request)` : ''} went into a database query${detail ? ` ("${String(detail).slice(0, 80)}")` : ''}.`
      : `${Math.round(culprit.durationMs)}ms went into a database call from ${culprit.service}${detail ? ` ("${String(detail).slice(0, 80)}")` : ''}.`;
    nextStep = `This looks database-bound — worth checking that query's plan/indexes, or whether the database itself is under load.`;
  } else if (!sameService) {
    message = `${Math.round(culprit.durationMs)}ms${culpritShare !== null ? ` (${culpritShare}% of the request)` : ''} was spent waiting on a downstream call to ${culprit.service} ("${culprit.operation}").`;
    nextStep = `Worth checking ${culprit.service}'s own health and logs first — the slowdown likely started there, not in ${serviceName}.`;
  } else {
    message = `${Math.round(culprit.durationMs)}ms${culpritShare !== null ? ` (${culpritShare}% of the request)` : ''} was spent inside ${serviceName} itself — no downstream call or database query in this trace accounts for it.`;
    nextStep = `Possibly CPU-bound work, lock contention, or something outside what tracing captures — worth checking ${serviceName}'s own CPU usage and application logs.`;
  }

  return {
    traceId: traceDetail.traceId,
    totalDurationMs: totalMs,
    culpritService: culprit.service,
    culpritOperation: culprit.operation,
    sharePercent: culpritShare,
    isError: Boolean(culprit.isError),
    category,
    message,
    nextStep,
  };
}

// Same base span query fetchTraceDetail runs, minus its top-15-by-duration
// slice — buildCriticalPathChain and the trace-logs route below both need
// the whole tree/time-window, not just "what's slow," so kept separate
// rather than changing fetchTraceDetail's contract for its existing callers.
async function fetchAllTraceSpans(traceId) {
  const rows = await queryClickHouse(`
    SELECT
      SpanId,
      ParentSpanId,
      ServiceName,
      SpanName,
      StatusCode,
      toUnixTimestamp64Nano(Timestamp) AS StartTimeUnixNano,
      Duration
    FROM ${CLICKHOUSE_TRACES_TABLE}
    WHERE TraceId = ${sqlString(traceId)}
    ORDER BY Timestamp ASC
  `);
  return rows.map((span) => ({
    spanId: span.SpanId,
    parentSpanId: span.ParentSpanId || null,
    service: span.ServiceName || 'unknown-service',
    operation: span.SpanName || 'unknown',
    isError: span.StatusCode >= 500,
    startNs: BigInt(span.StartTimeUnixNano || 0),
    durationMs: Number(span.Duration) / 1e6,
  }));
}

function traceWindowNs(spans) {
  const startNs = spans.reduce((min, s) => (s.startNs < min ? s.startNs : min), spans[0].startNs);
  const endNs = spans.reduce((max, s) => {
    const end = s.startNs + BigInt(Math.round(s.durationMs * 1e6));
    return end > max ? end : max;
  }, startNs);
  return { startNs, endNs };
}

// Cross-service "critical path" — see the matching comment in
// apps/hosted/license-server/clickhouse.js (same function, duplicated for
// the same reason buildPossibleCause already is between these two apps).
// Honest, cheap version: walk back from whichever span was still running
// when the trace finally ended, through its parentSpanId chain to the
// root. NOT a full critical-path algorithm (no gap analysis across
// concurrently-running spans) — a span that ran alongside the real
// culprit but wasn't itself the last to finish is correctly left out.
function buildCriticalPathChain(spans) {
  if (!spans || spans.length === 0) return [];
  // FIX — the first version of this walked UP from whichever single span
  // had the latest end time, globally, to the root. That's wrong: a
  // parent span's own duration normally already spans its entire
  // subtree (it's wall-clock time of the handler, which includes every
  // downstream call it made), so the globally-latest-ending span is
  // almost always just the ROOT span itself — confirmed with a synthetic
  // 4-span test trace before shipping, which returned a useless 1-hop
  // "chain" of just the root. The actual critical path has to walk DOWN
  // from the root, and at each level descend into whichever CHILD ended
  // latest relative to its parent — that's the child who was still
  // running right up until its parent finished, i.e. who was actually
  // "on the hook" for that parent's own duration. Stop at whichever leaf
  // has no further children.
  const spanIds = new Set(spans.map((s) => s.spanId));
  const childrenByParent = new Map();
  for (const s of spans) {
    const key = s.parentSpanId && spanIds.has(s.parentSpanId) ? s.parentSpanId : null;
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(s);
  }
  const latestEnding = (list) =>
    list.reduce((latest, s) => {
      const latestEnd = latest.startNs + BigInt(Math.round(latest.durationMs * 1e6));
      const sEnd = s.startNs + BigInt(Math.round(s.durationMs * 1e6));
      return sEnd > latestEnd ? s : latest;
    }, list[0]);

  const roots = childrenByParent.get(null) || [];
  if (roots.length === 0) return [];
  let current = latestEnding(roots);

  const chain = [];
  const seen = new Set();
  while (current && !seen.has(current.spanId)) {
    seen.add(current.spanId);
    chain.push({
      service: current.service,
      operation: current.operation,
      durationMs: Math.round(current.durationMs),
      isError: Boolean(current.isError),
    });
    const children = childrenByParent.get(current.spanId) || [];
    if (children.length === 0) break;
    current = latestEnding(children);
  }
  return chain;
}

app.get('/api/traces/:id/critical-path', async (req, res) => {
  try {
    const spans = await fetchAllTraceSpans(req.params.id);
    if (spans.length === 0) return res.json({ available: false, reason: 'not-found' });
    const { startNs, endNs } = traceWindowNs(spans);
    res.json({
      available: true,
      traceId: req.params.id,
      totalDurationMs: Number(endNs - startNs) / 1e6,
      confidence: 'approximate',
      chain: buildCriticalPathChain(spans),
    });
  } catch (err) {
    res.status(502).json({ error: describeFetchError(err) });
  }
});

// Logs from every service involved in this trace, best-effort matched to
// its time window — NOT real log-trace correlation (that needs trace
// context injected into log lines, which zero-code instrumentation can't
// do), just "what did each involved container log while this request was
// in flight," widened a couple of seconds each side for clock skew/async
// tail work. Assumes a trace span's service name is also that container's
// Docker name — holds for how this stack names things by default, not
// guaranteed in general, same confidence framing as buildPossibleCause.
app.get('/api/traces/:id/logs', async (req, res) => {
  try {
    const spans = await fetchAllTraceSpans(req.params.id);
    if (spans.length === 0) return res.json({ available: false, reason: 'not-found' });
    const { startNs, endNs } = traceWindowNs(spans);
    const padNs = 2000000000n; // 2s pad each side
    const windowStartMs = Number(startNs - padNs) / 1e6;
    const windowEndMs = Number(endNs + padNs) / 1e6;
    const services = [...new Set(spans.map((s) => s.service))];
    const containers = await listContainers();
    const perService = await Promise.all(
      services.map(async (serviceName) => {
        const container = containers.find((c) => c.name === serviceName) || null;
        if (!container) return [];
        try {
          const buffer = await dockerRequest(
            'GET',
            `/containers/${container.id}/logs?stdout=true&stderr=true&timestamps=true&tail=1000`
          );
          return demuxDockerLogs(buffer)
            .map(parseDockerLogLine)
            .filter((l) => l.ts)
            .map((l) => ({ ...l, service: serviceName, tsMs: Date.parse(l.ts) }))
            .filter((l) => l.tsMs >= windowStartMs && l.tsMs <= windowEndMs);
        } catch {
          return [];
        }
      })
    );
    const lines = perService.flat().sort((a, b) => a.tsMs - b.tsMs);
    res.json({ available: true, traceId: req.params.id, windowStartMs, windowEndMs, lines: lines.slice(0, 500) });
  } catch (err) {
    res.status(502).json({ error: describeFetchError(err) });
  }
});

// Same container-name -> Beyla-runtime-name fallback dance as the route
// right below (deliberately duplicated rather than factored out — this
// route and /traces diverge on what they do with the result, and the
// fallback itself is short enough that sharing it isn't worth coupling
// two otherwise-independent routes together).
app.get('/api/services/:name/possible-cause', async (req, res) => {
  try {
    const name = req.params.name;
    let result = await recentTraceList(name, {});
    let resolvedName = name;
    if (!result.traces || result.traces.length === 0) {
      try {
        const containers = await listContainers();
        const container = containers.find((c) => c.name === name) || null;
        const beylaName = await resolveBeylaServiceName(container);
        if (beylaName && beylaName !== name) {
          const instanceIds = await resolveBeylaInstanceIds(container);
          const beylaResult = await recentTraceList(beylaName, { instanceIds });
          if (beylaResult.traces && beylaResult.traces.length > 0) {
            result = beylaResult;
            resolvedName = beylaName;
          }
        }
      } catch {
        // fall through with whatever the direct query returned (none)
      }
    }
    if (!result.traces || result.traces.length === 0) {
      return res.json({ available: false, reason: 'no-recent-traces' });
    }
    // Prefer a trace that actually errored over just the slowest one —
    // same priority buildPossibleCause applies at the span level, applied
    // here first at the trace level so an erroring trace isn't passed
    // over just because a merely-slow one happens to be first.
    const candidate = result.traces.find((t) => t.isError) || result.traces[0];
    const detail = await fetchTraceDetail(candidate.traceId);
    const cause = buildPossibleCause(resolvedName, detail);
    if (!cause) return res.json({ available: false, reason: 'no-spans' });
    res.json({ available: true, confidence: 'possible', ...cause });
  } catch (err) {
    res.status(502).json({ error: describeFetchError(err) });
  }
});

app.get('/api/services/:name/traces', async (req, res) => {
  try {
    const includeHealthChecks = req.query.showHealthChecks === '1' || req.query.showHealthChecks === 'true';
    const { sinceIso, untilIso } = parseTimeRangeQuery(req.query);
    const baseOpts = { includeHealthChecks, sinceIso, untilIso };
    let result = await recentTraceList(req.params.name, baseOpts);
    // Tagged the same way as /api/status's `trace.source` — see that
    // handler's comment. Lets the frontend show this list under the right
    // panel (Tracing vs eBPF) instead of guessing from entry.otel.enabled.
    if (result.traces && result.traces.length > 0) result.source = 'agent';
    // Same fallback as /api/status: a container-name query can legitimately
    // come up empty while Beyla has real data filed under this container's
    // runtime name instead — see resolveBeylaServiceName's comment.
    if ((!result.traces || result.traces.length === 0)) {
      try {
        const containers = await listContainers();
        const container = containers.find((c) => c.name === req.params.name) || null;
        const beylaName = await resolveBeylaServiceName(container);
        if (beylaName && beylaName !== req.params.name) {
          // See the matching comment in /api/status — instance IDs keep
          // this scoped to just this container even when its Beyla name is
          // shared with something else on the host.
          const instanceIds = await resolveBeylaInstanceIds(container);
          const beylaResult = await recentTraceList(beylaName, { ...baseOpts, instanceIds });
          if (beylaResult.traces && beylaResult.traces.length > 0) {
            beylaResult.source = 'beyla';
            result = beylaResult;
          }
        }
      } catch {
        // fall through with whatever the direct query returned
      }
    }
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: describeFetchError(err) });
  }
});

// Shared by every route below that accepts an optional historical window —
// both since AND until have to be present and parse to real dates, otherwise
// this is treated as "no range given" (falls back to whatever that route's
// own default window is) rather than a 400, since a stray/malformed query
// param shouldn't break an otherwise-normal request.
function parseTimeRangeQuery(query) {
  const since = query.since ? new Date(query.since) : null;
  const until = query.until ? new Date(query.until) : null;
  if (since && until && !Number.isNaN(since.getTime()) && !Number.isNaN(until.getTime()) && since < until) {
    return { sinceIso: since.toISOString(), untilIso: until.toISOString() };
  }
  return { sinceIso: null, untilIso: null };
}

// ---- Deploy markers -----------------------------------------------------
//
// See lastKnownContainerImage/pushDeployMarkers's comment (pollContainerHealth)
// for how these get recorded. This is the read side: a bounded, persisted
// list any panel can overlay on a time-series chart or a trace list so
// "why did this change" has a one-word candidate answer ("deploy") without
// anyone needing to go check `docker image ls` history by hand.
app.get('/api/deploy-markers', (req, res) => {
  const state = loadState();
  const serviceFilter = req.query.service || null;
  const hours = Math.max(1, parseInt(req.query.hours, 10) || 24);
  const cutoffMs = Date.now() - hours * 3600 * 1000;
  const markers = (state.deployMarkers || []).filter((m) => {
    if (serviceFilter && m.service !== serviceFilter) return false;
    return Date.parse(m.at) >= cutoffMs;
  });
  res.json({ markers });
});

// ---- Incident context: "what else happened around this moment" ---------
//
// The single most requested kind of "useful operation on logs/traces/
// metrics" this project heard: an error-rate spike or a latency alert tells
// you SOMETHING broke and roughly WHEN, but answering "why" has always meant
// manually opening the traces panel, then separately opening the logs panel,
// and eyeballing whether their timestamps line up. This does that
// correlation server-side instead: given one timestamp, return the traces
// AND the raw log lines from a window around it, plus any deploy marker in
// range — everything a person actually looks at when debugging "what just
// happened," in one call. `at` defaults to now (so hitting this with no
// query params gives "what's happening right now," useful for testing) and
// `windowSeconds` defaults to 120 (60s each side) — wide enough to catch a
// slow request's tail end and the log line it produced, narrow enough that
// a busy service's logs don't drown the one incident being looked at.
app.get('/api/services/:name/incident-context', async (req, res) => {
  const name = req.params.name;
  const atMs = req.query.at ? Date.parse(req.query.at) : Date.now();
  if (Number.isNaN(atMs)) {
    res.status(400).json({ error: 'invalid `at` timestamp' });
    return;
  }
  const windowSeconds = Math.min(3600, Math.max(10, parseInt(req.query.windowSeconds, 10) || 120));
  const sinceIso = new Date(atMs - (windowSeconds / 2) * 1000).toISOString();
  const untilIso = new Date(atMs + (windowSeconds / 2) * 1000).toISOString();

  let traces = { traces: [], hiddenHealthCheckCount: 0 };
  try {
    traces = await recentTraceList(name, { includeHealthChecks: true, sinceIso, untilIso });
    if (!traces.traces || traces.traces.length === 0) {
      const containers = await listContainers();
      const container = containers.find((c) => c.name === name) || null;
      const beylaName = await resolveBeylaServiceName(container);
      if (beylaName && beylaName !== name) {
        const instanceIds = await resolveBeylaInstanceIds(container);
        traces = await recentTraceList(beylaName, { includeHealthChecks: true, sinceIso, untilIso, instanceIds });
      }
    }
  } catch (err) {
    traces = { traces: [], hiddenHealthCheckCount: 0, error: describeFetchError(err) };
  }

  // Docker's own logs endpoint takes since/until as UNIX SECONDS (not ms,
  // not ISO) directly — no need to fetch a big tail and filter client-side
  // the way the plain log viewer does, Docker does the windowing itself.
  let logs = [];
  let logsError = null;
  try {
    const containers = await listContainers();
    const container = containers.find((c) => c.name === name) || null;
    if (container) {
      const sinceSec = Math.floor((atMs - (windowSeconds / 2) * 1000) / 1000);
      const untilSec = Math.ceil((atMs + (windowSeconds / 2) * 1000) / 1000);
      const buffer = await dockerRequest(
        'GET',
        `/containers/${container.id}/logs?stdout=true&stderr=true&timestamps=true&since=${sinceSec}&until=${untilSec}`
      );
      logs = demuxDockerLogs(buffer).map(parseDockerLogLine);
    } else {
      logsError = `No container named ${name}`;
    }
  } catch (err) {
    logsError = describeFetchError(err);
  }

  const state = loadState();
  const deployMarkers = (state.deployMarkers || []).filter((m) => {
    if (m.service !== name) return false;
    const t = Date.parse(m.at);
    return t >= atMs - (windowSeconds / 2) * 1000 && t <= atMs + (windowSeconds / 2) * 1000;
  });

  res.json({
    service: name,
    at: new Date(atMs).toISOString(),
    windowSeconds,
    traces: traces.traces || [],
    tracesError: traces.error || null,
    logs,
    logsError,
    deployMarkers,
  });
});

// Raw log tail for one service's container — read-only, no parsing beyond
// splitting off Docker's own per-line timestamp (see parseDockerLogLine).
// Works for any container Docker knows about by name, same as the traces
// route above, not gated on `watched` — the frontend only calls this for a
// row that's already open, but nothing here depends on that.
app.get('/api/services/:name/logs', async (req, res) => {
  try {
    const tail = Math.min(parseInt(req.query.tail, 10) || LOG_TAIL_LINES_DEFAULT, LOG_TAIL_LINES_MAX);
    const containers = await listContainers();
    const container = containers.find((c) => c.name === req.params.name) || null;
    if (!container) {
      res.status(404).json({ error: `No container named ${req.params.name}` });
      return;
    }
    const buffer = await dockerRequest(
      'GET',
      `/containers/${container.id}/logs?stdout=true&stderr=true&timestamps=true&tail=${tail}`
    );
    const lines = demuxDockerLogs(buffer).map(parseDockerLogLine);
    res.json({ lines });
  } catch (err) {
    res.status(502).json({ error: describeFetchError(err) });
  }
});

// Same container logs as the raw tail above, grouped into recurring
// patterns instead of shown line-by-line — see "Log clustering" above for
// how. A separate, larger tail (LOG_CLUSTER_TAIL_DEFAULT vs
// LOG_TAIL_LINES_DEFAULT) on purpose: clustering wants enough lines to
// actually reveal which shapes repeat, where the raw viewer's smaller
// default is about staying readable at a glance.
app.get('/api/services/:name/log-clusters', async (req, res) => {
  try {
    const tail = Math.min(parseInt(req.query.tail, 10) || LOG_CLUSTER_TAIL_DEFAULT, LOG_CLUSTER_TAIL_MAX);
    const containers = await listContainers();
    const container = containers.find((c) => c.name === req.params.name) || null;
    if (!container) {
      res.status(404).json({ error: `No container named ${req.params.name}` });
      return;
    }
    const buffer = await dockerRequest(
      'GET',
      `/containers/${container.id}/logs?stdout=true&stderr=true&timestamps=true&tail=${tail}`
    );
    const entries = demuxDockerLogs(buffer).map(parseDockerLogLine);
    const allClusters = clusterLogLines(entries);
    res.json({
      linesExamined: entries.length,
      clusterCount: allClusters.length,
      truncated: allClusters.length > LOG_CLUSTER_LIMIT,
      clusters: allClusters.slice(0, LOG_CLUSTER_LIMIT),
    });
  } catch (err) {
    res.status(502).json({ error: describeFetchError(err) });
  }
});

// Historical clustered view, sourced from ClickHouse instead of a live
// tail — only meaningful for a service with log-pattern storage actually
// enabled (see POST .../log-storage above); returns an empty-but-valid
// response rather than an error for one that isn't, since "not opted in"
// is an expected, common state, not a fault. `hours` is clamped to
// whatever's actually retained (state.logRetention.hours) — asking for a
// window longer than what's kept would silently return a partial result
// that LOOKS complete, which is exactly the honesty problem flagged when
// this feature was being discussed; returning the clamped value lets the
// UI show "showing 7d (your retention), not the 30d you asked for."
app.get('/api/services/:name/log-patterns/history', async (req, res) => {
  const name = req.params.name;
  const state = loadState();
  const entry = state.services[name];
  if (!entry || !entry.logStorage || !entry.logStorage.enabled) {
    res.json({ enabled: false, hoursRequested: null, hoursUsed: null, clusters: [] });
    return;
  }
  const requestedHours = Math.max(1, parseInt(req.query.hours, 10) || 24);
  const hours = Math.min(requestedHours, state.logRetention.hours);
  try {
    const rows = await queryClickHouse(`
      SELECT Pattern, Level, sum(Count) AS count,
        min(Timestamp) AS firstSeen, max(Timestamp) AS lastSeen,
        argMax(SampleLine, Timestamp) AS sample
      FROM ${CLICKHOUSE_LOG_PATTERNS_TABLE}
      WHERE ServiceName = ${sqlString(name)} AND Timestamp >= now() - INTERVAL ${hours} HOUR
      GROUP BY Pattern, Level
      ORDER BY count DESC
      LIMIT ${LOG_CLUSTER_LIMIT * 4}
    `);
    const clusters = mergeLogPatternRows(rows).slice(0, LOG_CLUSTER_LIMIT);
    res.json({ enabled: true, hoursRequested: requestedHours, hoursUsed: hours, clusterCount: clusters.length, clusters });
  } catch (err) {
    res.status(502).json({ error: describeFetchError(err) });
  }
});

// Basic log search: a plain case-insensitive substring match over a larger
// tail of this container's own logs — same "pull a bigger tail, process it
// in Node" approach as clustering above, because Docker's own logs API has
// no search of its own to delegate to. Deliberately just a substring match,
// not a regex/query-language search: this is meant to complement the Live
// tab's own instant CLIENT-side filter (limited to whatever's already
// arrived over that SSE connection) for anything further back than that —
// "basic" on purpose, matching what was actually asked for.
const LOG_SEARCH_TAIL_DEFAULT = 500;
const LOG_SEARCH_TAIL_MAX = 2000;
const LOG_SEARCH_MATCH_LIMIT = 300; // most-recent matches only, past this — a search matching hundreds of lines isn't something anyone scrolls through fully anyway

app.get('/api/services/:name/logs/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toString();
    if (!q.trim()) {
      res.json({ linesExamined: 0, matchCount: 0, truncated: false, matches: [] });
      return;
    }
    const tail = Math.min(parseInt(req.query.tail, 10) || LOG_SEARCH_TAIL_DEFAULT, LOG_SEARCH_TAIL_MAX);
    const containers = await listContainers();
    const container = containers.find((c) => c.name === req.params.name) || null;
    if (!container) {
      res.status(404).json({ error: `No container named ${req.params.name}` });
      return;
    }
    const buffer = await dockerRequest(
      'GET',
      `/containers/${container.id}/logs?stdout=true&stderr=true&timestamps=true&tail=${tail}`
    );
    const entries = demuxDockerLogs(buffer).map(parseDockerLogLine);
    const needle = q.toLowerCase();
    const matches = entries.filter((e) => e.line && e.line.toLowerCase().includes(needle));
    res.json({
      linesExamined: entries.length,
      matchCount: matches.length,
      truncated: matches.length > LOG_SEARCH_MATCH_LIMIT,
      // Most RECENT matches when there are more than the cap — slice(-N)
      // keeps the tail end of an already chronologically-ordered array,
      // consistent with everything else here defaulting to "what just
      // happened" over "what happened first".
      matches: matches.slice(-LOG_SEARCH_MATCH_LIMIT),
    });
  } catch (err) {
    res.status(502).json({ error: describeFetchError(err) });
  }
});

// Live tail over Server-Sent Events — "new lines appear as they happen",
// the same as `docker logs -f` or Grafana's own Live view, instead of the
// one-shot route above re-fetching a fixed slice on a timer. One long-lived
// GET rather than a poll loop: the browser's EventSource handles
// reconnects on its own, and this only holds one Docker log connection
// open per open panel (closed the moment the client disconnects — see
// req.on('close') below), not one per poll tick.
app.get('/api/services/:name/logs/stream', async (req, res) => {
  let container;
  try {
    const containers = await listContainers();
    container = containers.find((c) => c.name === req.params.name) || null;
  } catch (err) {
    res.status(502).json({ error: describeFetchError(err) });
    return;
  }
  if (!container) {
    res.status(404).json({ error: `No container named ${req.params.name}` });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // in case anything ever fronts this with nginx — stops it from buffering the stream
  });
  res.write(':connected\n\n');

  const tail = Math.min(parseInt(req.query.tail, 10) || 100, LOG_TAIL_LINES_MAX);
  const stream = streamContainerLogs(container.id, { tail });
  stream.onLine((line) => {
    res.write(`data: ${JSON.stringify(parseDockerLogLine(line))}\n\n`);
  });
  stream.onError((err) => {
    res.write(`event: error\ndata: ${JSON.stringify({ error: describeFetchError(err) })}\n\n`);
    res.end();
  });
  // SSE connections sitting idle can get silently dropped by proxies/load
  // balancers that time out a connection with no traffic — a periodic
  // comment line (ignored by EventSource, since it has no "data:" field)
  // keeps bytes flowing without ever surfacing as a fake log line.
  const keepAlive = setInterval(() => res.write(':ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(keepAlive);
    stream.destroy();
  });
});

// One trace's per-span breakdown, slowest span first — "what's slow, where,
// why" for that specific request. See fetchTraceDetail for the shape.
app.get('/api/traces/:id', async (req, res) => {
  try {
    const detail = await fetchTraceDetail(req.params.id);
    res.json(detail);
  } catch (err) {
    res.status(502).json({ error: describeFetchError(err) });
  }
});

// Temporary diagnostic — NOT wired into any UI. The exact Prometheus
// metric/label names Beyla 3.33.0 actually emits haven't been confirmed
// against a live scrape yet (see isRequestDurationCountMetric/firstLabel's
// comment); this exists to check that against the real deployment without
// needing shell access to the box. Safe to remove once the RED numbers in
// /api/status are confirmed to look right — it only ever reflects Beyla's
// own already-public metric names, nothing service-specific or sensitive.
app.get('/api/debug/beyla-metrics', async (req, res) => {
  try {
    const r = await fetch(BEYLA_METRICS_URL, { signal: AbortSignal.timeout(5000) });
    const text = await r.text();
    res.set('Content-Type', 'text/plain');
    res.send(text);
  } catch (err) {
    res.status(502).json({ error: describeFetchError(err), lastPollError: redMetricsLastError });
  }
});
app.get('/api/debug/beyla-metrics-summary', (req, res) => {
  res.json({
    lastError: redMetricsLastError,
    sampleMetricNames: redMetricsLastRawSampleNames,
    computedKeys: [...redMetricsCurrent.entries()],
  });
});

// ---- Ad-hoc debug query: Grafana-Explore-style access to podotype's own
// data --------------------------------------------------------------------
//
// Everything else in this file queries ClickHouse through a fixed,
// pre-written query built for one specific panel. This is the opposite on
// purpose: a raw, read-only SQL escape hatch against the exact same
// ClickHouse database every other endpoint here already reads (otel_traces,
// log_patterns, container_metrics — see /api/query/tables just below for
// the live schema), for whatever debugging question none of those fixed
// panels anticipated — "every span over 2s today, grouped by service,"
// "error logs across every service in the last hour," things a person would
// normally reach for Grafana Explore to answer. Gated behind the exact same
// PODOTYPE_ENGINE_API_KEY every other /api/* route already requires (see
// app.use('/api', requireEngineKey) above) — this is the operator's own
// dashboard talking to their own ClickHouse, not a new trust boundary.
//
// Scoped narrowly: single statement, SELECT/WITH only. This is a prefix
// check plus a blocklist, not a real SQL parser — enough to catch a typo or
// an accidentally-pasted DROP, not meant to withstand a hostile caller who
// already holds the engine key (who could just curl ClickHouse's own HTTP
// port directly at that point anyway, same trust level).
const QUERY_ROW_LIMIT_DEFAULT = 1000;
const QUERY_ROW_LIMIT_MAX = 5000;
const QUERY_TIMEOUT_MS = 20000;
const QUERY_FORBIDDEN_RE =
  /\b(insert|update|delete|alter|drop|truncate|create|rename|grant|revoke|attach|detach|optimize|kill|system|exchange)\b/i;

function validateReadOnlyQuery(sql) {
  const trimmed = (sql || '').trim();
  if (!trimmed) return { error: 'query is empty' };
  const statements = trimmed
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (statements.length !== 1) return { error: 'only a single statement is allowed (no semicolons)' };
  const statement = statements[0];
  if (!/^(select|with)\b/i.test(statement)) return { error: 'only SELECT (or WITH ... SELECT) queries are allowed' };
  if (QUERY_FORBIDDEN_RE.test(statement)) {
    return { error: 'query contains a forbidden keyword — only read-only SELECTs are allowed' };
  }
  return { statement };
}

app.post('/api/query', async (req, res) => {
  const { sql, limit } = req.body || {};
  const { statement, error } = validateReadOnlyQuery(sql);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const rowLimit = Math.min(QUERY_ROW_LIMIT_MAX, Math.max(1, parseInt(limit, 10) || QUERY_ROW_LIMIT_DEFAULT));
  // Only auto-append a LIMIT when the query doesn't already specify one — a
  // naive \blimit\b check, so a query using "limit" as a column alias could
  // false-positive and skip the auto-cap. Accepted trade-off: better than
  // appending a second LIMIT clause ClickHouse would just reject outright.
  const hasOwnLimit = /\blimit\b/i.test(statement);
  const finalSql = hasOwnLimit ? statement : `${statement} LIMIT ${rowLimit}`;
  const startedAt = Date.now();
  try {
    const rows = await queryClickHouse(finalSql, { timeoutMs: QUERY_TIMEOUT_MS });
    res.json({ rows, rowCount: rows.length, tookMs: Date.now() - startedAt, sql: finalSql });
  } catch (err) {
    res.status(502).json({ error: describeFetchError(err), sql: finalSql });
  }
});

// Schema reference for the query console above — real columns/types
// straight from ClickHouse's own system.columns, so it can never drift from
// what ensureClickHouseSchema actually created the way a hand-maintained
// list could. Scoped to just this database's own tables.
app.get('/api/query/tables', async (req, res) => {
  try {
    const rows = await queryClickHouse(
      `SELECT table, name AS column, type FROM system.columns WHERE database = ${sqlString(CLICKHOUSE_DATABASE)} ORDER BY table, position`,
      { database: 'default' }
    );
    const tables = new Map();
    for (const r of rows) {
      if (!tables.has(r.table)) tables.set(r.table, []);
      tables.get(r.table).push({ column: r.column, type: r.type });
    }
    res.json({ database: CLICKHOUSE_DATABASE, tables: Object.fromEntries(tables) });
  } catch (err) {
    res.status(502).json({ error: describeFetchError(err) });
  }
});

// See BUILD_MARKER above for why this exists. startedAt lets you also tell
// "redeployed" apart from "same image, container just restarted" — a fresh
// BUILD_MARKER with an old startedAt would itself be a sign something's off.
const serverStartedAt = new Date().toISOString();
app.get('/api/version', (req, res) => {
  res.json({ buildMarker: BUILD_MARKER, startedAt: serverStartedAt });
});

// ---- startup ---------------------------------------------------------------

// Order matters: wait for ClickHouse to actually answer before trying to
// create the table against it (matching docker-compose.yml's
// `depends_on: clickhouse: condition: service_healthy` at the container
// level with the same wait at the application level), and don't start
// accepting incoming spans until the table they'd be inserted into exists.
//
// ensureClickHouseSchema used to be a single try-once call here: if it
// failed for ANY reason (the database=/default bug above, or a real
// transient issue like ClickHouse still finishing its own startup work
// after /ping starts responding), trace ingestion was broken for the life
// of the container — the only recovery was a manual restart. Retrying with
// backoff here means a transient failure heals itself instead of silently
// wedging the whole trace pipeline until someone notices "no traces" days
// later.
(async () => {
  await logWhenClickHouseReady();
  for (let attempt = 1; !shuttingDown; attempt++) {
    try {
      await ensureClickHouseSchema();
      break;
    } catch (err) {
      const delayMs = Math.min(30000, attempt * 5000);
      console.error(`[app] failed to create ClickHouse schema (attempt ${attempt}): ${err.message} — retrying in ${delayMs / 1000}s`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  // Re-assert whatever retention is saved in state.json even on a restart
  // where CREATE TABLE IF NOT EXISTS above was a no-op (table already
  // existed) — otherwise a retention change made via the settings UI would
  // silently revert to CLICKHOUSE_TRACE_TTL_HOURS's baked-in CREATE TABLE
  // value the next time this container restarts. Best-effort: a failure
  // here logs and moves on rather than blocking startup, same as any other
  // non-critical startup step in this file.
  try {
    await applyRetentionTtl(loadState().retention.hours);
  } catch (err) {
    console.warn(`[app] failed to (re)apply saved trace retention on startup: ${err.message}`);
  }
  // Same re-assert, same reasoning, for the separate log-pattern TTL.
  try {
    await applyLogPatternRetentionTtl(loadState().logRetention.hours);
  } catch (err) {
    console.warn(`[app] failed to (re)apply saved log-pattern retention on startup: ${err.message}`);
  }
  startOtlpIngestServer();
})();
startConfiguredChecks();
// Seed in-memory alertHistory from disk — see pushAlertHistory's own
// comment for why this is now persisted, not just kept in memory.
alertHistory = loadState().alertHistory || [];
checkStorage();
setInterval(checkStorage, STORAGE_CHECK_INTERVAL_MS);
pollBeylaRedMetrics().catch(() => {}); // first poll just establishes a baseline — no rate until the second one has something to diff against
setInterval(() => {
  pollBeylaRedMetrics().catch(() => {});
}, RED_METRICS_POLL_INTERVAL_MS);
pollContainerHealth().catch(() => {});
sampleHostStats();
setInterval(() => {
  pollContainerHealth().catch(() => {});
  sampleHostStats();
}, CONTAINER_STATS_POLL_INTERVAL_MS);
// Long-term metrics history — see CLICKHOUSE_CONTAINER_METRICS_TABLE's
// comment. Started after the very first pollContainerHealth/pollBeylaRedMetrics
// calls above so its first snapshot already has real health/RED data to
// read from, not an empty cache.
setInterval(() => {
  persistContainerMetricsSnapshot().catch(() => {});
}, CONTAINER_METRICS_SNAPSHOT_INTERVAL_MS);
// Runs after the pollers above so its very first cycle already has fresh
// storage/container-health data to judge, rather than starting from an
// all-null cache — not load-bearing (a healthy condition just needs one
// real reading to start counting from), but avoids a spurious empty first
// tick.
evaluateAlerts().catch(() => {});
setInterval(() => {
  evaluateAlerts().catch(() => {});
}, ALERT_EVAL_INTERVAL_MS);

// Same cadence as the container-health poller above — starting/stopping
// tailers for whichever services are currently opted into log storage.
// See reconcileLogIngestion's own comment for what it actually does each
// tick.
reconcileLogIngestion().catch(() => {});
setInterval(() => {
  reconcileLogIngestion().catch(() => {});
}, CONTAINER_STATS_POLL_INTERVAL_MS);
setInterval(() => {
  flushLogPatterns().catch(() => {});
}, LOG_PATTERN_FLUSH_INTERVAL_MS);

// No license heartbeat, no free-tier cap sweep — self-hosted doesn't need either.

app.listen(PORT, () => {
  console.log(
    `[engine] podotype engine API listening on :${PORT} (key ${ENGINE_API_KEY ? 'required' : 'NOT set — unauthenticated'}), querying Docker at ${DOCKER_SOCKET} and ClickHouse at ${CLICKHOUSE_URL}`
  );
});
