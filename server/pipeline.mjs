// Tandem Schema → real database pipeline, governed by Argus.
//
// Stages (each emits a pipeline event and an Argus audit record):
//   verify    — lint the diagram, prove export→reimport round-trip fidelity,
//               rehearse the DDL on a scratch database and diff what was built.
//   provision — create a real staging/prod database from a verified diagram
//               (pg_dump backup of anything that exists first).
//   migrate   — diff the live database against the diagram, generate ALTERs,
//               classify each as additive or destructive. Destructive changes
//               are sent to Argus (which blocks db.destructive) and require an
//               explicit human approval recorded via /api/pipeline/approve.
//
// Argus integration is real, not cosmetic: every SQL action is submitted to
// the Argus Gateway /v1/govern before it runs; the decision (allow/block,
// capability, reason) is what the room watcher shows and what lands in the
// Argus ledger for the fleet dashboard.

import { execFile } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sqlParserPkg from "node-sql-parser";
import { importSQL, exportSQL, DB } from "./lib.mjs";

const { Parser } = sqlParserPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PG_CONTAINER = process.env.PG_CONTAINER || "buzz-prod-postgres-1";
const PG_USER = process.env.PG_USER || "buzz";
const ARGUS_GATEWAY = process.env.ARGUS_GATEWAY || "http://127.0.0.1:8787";
const ARGUS_TOKEN = process.env.ARGUS_TOKEN || "tok_service_G7H8I9";
const STATE_DIR = process.env.PIPELINE_DIR || path.join(__dirname, "pipeline");
const EVENTS_FILE = path.join(STATE_DIR, "events.jsonl");
const APPROVALS_FILE = path.join(STATE_DIR, "approvals.json");
const BACKUP_DIR = path.join(STATE_DIR, "backups");

fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ---------------------------------------------------------------- events

export function emitEvent(event) {
  const record = { id: randomUUID(), ts: new Date().toISOString(), ...event };
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(record) + "\n");
  return record;
}

export function readEvents(sinceTs) {
  if (!fs.existsSync(EVENTS_FILE)) return [];
  const lines = fs.readFileSync(EVENTS_FILE, "utf8").trim().split("\n");
  const events = lines.filter(Boolean).map((l) => JSON.parse(l));
  return sinceTs ? events.filter((e) => e.ts > sinceTs) : events;
}

// ---------------------------------------------------------------- approvals

function readApprovals() {
  try {
    return JSON.parse(fs.readFileSync(APPROVALS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeApprovals(a) {
  fs.writeFileSync(APPROVALS_FILE, JSON.stringify(a, null, 1));
}

export function requestApproval(kind, detail) {
  const approvals = readApprovals();
  const id = `apr_${randomUUID().slice(0, 8)}`;
  approvals[id] = {
    id,
    kind,
    detail,
    status: "pending",
    requested_at: new Date().toISOString(),
  };
  writeApprovals(approvals);
  return approvals[id];
}

export function grantApproval(id, approvedBy) {
  const approvals = readApprovals();
  if (!approvals[id]) return null;
  approvals[id].status = "approved";
  approvals[id].approved_by = approvedBy || "owner";
  approvals[id].approved_at = new Date().toISOString();
  writeApprovals(approvals);
  return approvals[id];
}

export function getApproval(id) {
  return readApprovals()[id] || null;
}

// ---------------------------------------------------------------- Argus

// Ask Argus to govern one SQL action. Returns the real gateway decision:
// { decision: "allow"|"block", capability, reason, offline? }.
export async function argusGovern(query, context) {
  try {
    const res = await fetch(`${ARGUS_GATEWAY}/v1/govern`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Argus-Token": ARGUS_TOKEN,
      },
      body: JSON.stringify({ action: { type: "sql", query } }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => ({}));
    return {
      decision: body.decision || (res.ok ? "allow" : "block"),
      capability: body.capability || null,
      reason: body.reason || null,
      context: context || null,
    };
  } catch (err) {
    // Fail CLOSED: if the governor is unreachable, nothing runs.
    return {
      decision: "block",
      capability: "governor.unreachable",
      reason: `Argus gateway unreachable (${err.message}) — failing closed`,
      offline: true,
      context: context || null,
    };
  }
}

// ---------------------------------------------------------------- postgres

function pgExec(args, stdin) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "docker",
      ["exec", ...(stdin ? ["-i"] : []), PG_CONTAINER, "psql", "-U", PG_USER, ...args],
      { timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.slice(0, 500) || err.message));
        else resolve(stdout);
      },
    );
    if (stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

function pgDump(dbName, label) {
  const file = path.join(
    BACKUP_DIR,
    `${dbName}-${label}-${Date.now()}.sql`,
  );
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      ["exec", PG_CONTAINER, "pg_dump", "-U", PG_USER, dbName],
      { timeout: 120000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        fs.writeFileSync(file, stdout);
        resolve(file);
      },
    );
  });
}

async function dbExists(name) {
  const out = await pgExec(["-t", "-A", "-c", `SELECT 1 FROM pg_database WHERE datname='${name}'`]);
  return out.trim() === "1";
}

async function introspect(dbName) {
  const out = await pgExec([
    "-d", dbName, "-t", "-A", "-F", "|",
    "-c",
    "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position",
  ]);
  const tables = {};
  for (const line of out.trim().split("\n")) {
    if (!line) continue;
    const [table, column, type] = line.split("|");
    (tables[table] ||= {})[column] = type;
  }
  return tables;
}

// ---------------------------------------------------------------- verify

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function lintDiagram(diagram) {
  const issues = [];
  const tables = diagram.tables || [];
  if (tables.length === 0) issues.push({ level: "error", msg: "Diagram has no tables." });
  const names = new Set();
  for (const t of tables) {
    if (!NAME_RE.test(t.name)) issues.push({ level: "error", msg: `Table name "${t.name}" is not a safe SQL identifier.` });
    if (names.has(t.name.toLowerCase())) issues.push({ level: "error", msg: `Duplicate table name "${t.name}".` });
    names.add(t.name.toLowerCase());
    const fields = t.fields || [];
    if (fields.length === 0) issues.push({ level: "error", msg: `Table "${t.name}" has no fields.` });
    if (!fields.some((f) => f.primary)) issues.push({ level: "warn", msg: `Table "${t.name}" has no primary key.` });
    const fnames = new Set();
    for (const f of fields) {
      if (!NAME_RE.test(f.name)) issues.push({ level: "error", msg: `Field "${t.name}.${f.name}" is not a safe SQL identifier.` });
      if (fnames.has(f.name.toLowerCase())) issues.push({ level: "error", msg: `Duplicate field "${f.name}" in table "${t.name}".` });
      fnames.add(f.name.toLowerCase());
    }
  }
  for (const r of diagram.relationships || []) {
    const start = tables.find((t) => t.id === r.startTableId);
    const end = tables.find((t) => t.id === r.endTableId);
    if (!start || !end) issues.push({ level: "error", msg: `Relationship "${r.name}" points at a missing table.` });
  }
  return issues;
}

function normalizeShape(tables) {
  const shape = {};
  for (const t of tables || []) {
    shape[t.name.toLowerCase()] = (t.fields || [])
      .map((f) => f.name.toLowerCase())
      .sort();
  }
  return shape;
}

export function roundTrip(diagram, db) {
  // exportSQL is written against the editor's in-memory shape: relationships
  // are called `references` and every table carries indices/uniqueConstraints
  // arrays. Share JSON uses `relationships` and may omit the empties.
  const exportable = {
    ...diagram,
    database: db,
    tables: (diagram.tables || []).map((t) => ({
      comment: "",
      indices: [],
      uniqueConstraints: [],
      ...t,
    })),
    references: diagram.relationships || diagram.references || [],
    types: diagram.types || [],
    enums: diagram.enums || [],
  };
  const sql = exportSQL(exportable);
  const ast = new Parser().astify(sql, { database: db });
  const reimported = importSQL(ast, db, db);
  const a = normalizeShape(diagram.tables);
  const b = normalizeShape(reimported.tables);
  const diffs = [];
  for (const t of Object.keys(a)) {
    if (!b[t]) diffs.push(`table "${t}" missing after round-trip`);
    else if (JSON.stringify(a[t]) !== JSON.stringify(b[t]))
      diffs.push(`fields differ in "${t}": [${a[t]}] vs [${b[t]}]`);
  }
  for (const t of Object.keys(b)) if (!a[t]) diffs.push(`unexpected table "${t}" after round-trip`);
  return { ok: diffs.length === 0, sql, diffs };
}

export async function rehearse(sql, expectedTables) {
  const scratch = `rehearsal_${Date.now()}`;
  await pgExec(["-c", `CREATE DATABASE ${scratch}`]);
  try {
    await pgExec(["-d", scratch, "-v", "ON_ERROR_STOP=1"], sql);
    const built = await introspect(scratch);
    const builtNames = Object.keys(built).sort();
    const expected = expectedTables.map((t) => t.toLowerCase()).sort();
    const missing = expected.filter((t) => !builtNames.includes(t));
    return {
      ok: missing.length === 0,
      tablesBuilt: builtNames,
      missing,
    };
  } finally {
    // Internal scratch cleanup — not an agent action, not governed.
    await pgExec(["-c", `DROP DATABASE IF EXISTS ${scratch}`]).catch(() => {});
  }
}

// ---------------------------------------------------------------- migrate

// Identifier/type validation for SQL we assemble ourselves. Diagrams are
// user-supplied JSON (the share API is open by design), so nothing from a
// diagram may reach a SQL string unless it matches these shapes.
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const TYPE_RE = /^[a-zA-Z_][a-zA-Z0-9_ ]*$/; // e.g. VARCHAR, DOUBLE PRECISION
const SIZE_RE = /^[0-9]+(,[0-9]+)?$/;

export function assertSafeIdent(name, what) {
  if (!IDENT_RE.test(String(name))) {
    throw new Error(`Unsafe ${what} identifier rejected: ${JSON.stringify(String(name).slice(0, 60))}`);
  }
  return name;
}

function assertSafeType(field) {
  if (!TYPE_RE.test(String(field.type))) {
    throw new Error(`Unsafe SQL type rejected on "${field.name}": ${JSON.stringify(String(field.type).slice(0, 60))}`);
  }
  if (field.size !== undefined && field.size !== "" && !SIZE_RE.test(String(field.size))) {
    throw new Error(`Unsafe type size rejected on "${field.name}"`);
  }
}

const TYPE_FAMILY = {
  integer: "int", bigint: "int", smallint: "int", serial: "int",
  "character varying": "text", character: "text", text: "text", varchar: "text",
  "timestamp without time zone": "timestamp", "timestamp with time zone": "timestamp",
  timestamp: "timestamp", date: "date",
  numeric: "decimal", decimal: "decimal", "double precision": "decimal", real: "decimal",
  boolean: "bool",
};

function familyOf(type) {
  const t = String(type || "").toLowerCase().replace(/\(.*\)/, "").trim();
  return TYPE_FAMILY[t] || t;
}

function diagramFieldSql(field) {
  assertSafeIdent(field.name, "column");
  assertSafeType(field);
  const size = field.size && SIZE_RE.test(String(field.size)) ? `(${field.size})` : "";
  return `"${field.name}" ${field.type}${size}${field.notNull ? " NOT NULL" : ""}`;
}

// Diff live DB vs diagram → { additive: [sql], destructive: [{sql, why}] }.
// Every identifier — from the diagram AND from introspection — is validated
// before being embedded, and embedded double-quoted.
export function planMigration(live, diagram) {
  const additive = [];
  const destructive = [];
  const dTables = {};
  for (const t of diagram.tables || []) {
    assertSafeIdent(t.name, "table");
    dTables[t.name.toLowerCase()] = t;
  }

  for (const [name, t] of Object.entries(dTables)) {
    if (!live[name]) {
      const fields = (t.fields || []).map(diagramFieldSql).join(", ");
      const pks = (t.fields || [])
        .filter((f) => f.primary)
        .map((f) => `"${assertSafeIdent(f.name, "column")}"`);
      additive.push(
        `CREATE TABLE "${name}" (${fields}${pks.length ? `, PRIMARY KEY (${pks.join(", ")})` : ""})`,
      );
      continue;
    }
    for (const f of t.fields || []) {
      assertSafeIdent(f.name, "column");
      const liveType = live[name][f.name];
      if (liveType === undefined) {
        additive.push(`ALTER TABLE "${name}" ADD COLUMN ${diagramFieldSql(f)}`);
      } else if (familyOf(liveType) !== familyOf(f.type)) {
        assertSafeType(f);
        destructive.push({
          sql: `ALTER TABLE "${name}" ALTER COLUMN "${f.name}" TYPE ${f.type}`,
          why: `changes ${name}.${f.name} from ${liveType} to ${f.type} — existing data may not convert`,
        });
      }
    }
    for (const col of Object.keys(live[name])) {
      assertSafeIdent(col, "live column");
      if (!(t.fields || []).some((f) => f.name.toLowerCase() === col.toLowerCase())) {
        destructive.push({
          sql: `ALTER TABLE "${name}" DROP COLUMN "${col}"`,
          why: `deletes column ${name}.${col} and ALL data stored in it`,
        });
      }
    }
  }
  for (const name of Object.keys(live)) {
    assertSafeIdent(name, "live table");
    if (!dTables[name]) {
      destructive.push({
        sql: `DROP TABLE "${name}" CASCADE`,
        why: `deletes table ${name}, ALL its rows, and every link other tables have to it`,
      });
    }
  }
  return { additive, destructive };
}

export { pgExec, pgDump, dbExists, introspect };
