// Tandem Schema server.
//
// One process serves three things:
//   1. The built editor SPA (../dist) with SPA fallback.
//   2. A gist-compatible share API (/gists) backed by local JSON files —
//      same request/response shapes the frontend's src/api/gists.js expects,
//      so share links work fully self-hosted with no GitHub dependency.
//   3. The agent API (POST /api/diagram): accepts raw SQL or DBML, converts
//      it to a diagram using the editor's own import utilities, stores it as
//      a share, and returns a ready-to-open share URL. This is the endpoint
//      the Tandem agent fleet calls to publish diagrams into conversations.

import express from "express";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sqlParserPkg from "node-sql-parser";
import oracleParserPkg from "oracle-sql-parser";
const { Parser } = sqlParserPkg;
const OracleParser = oracleParserPkg.Parser || oracleParserPkg;
// lib.mjs is bundled from the editor's own import utilities by esbuild
// (see lib-entry.mjs; rebuild with `npm run build:server-lib`).
import { importSQL, parseDbml, arrangeTables, DB } from "./lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3310);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DIST_DIR = path.join(__dirname, "..", "dist");
const PUBLIC_URL = (
  process.env.PUBLIC_URL || "https://tandemschema.agentlumi.cloud"
).replace(/\/$/, "");

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: "10mb" }));

// ---------------------------------------------------------------- gist store

function gistPath(id) {
  // ids are uuids we generated; reject anything else to prevent traversal
  if (!/^[a-zA-Z0-9-]+$/.test(id)) return null;
  return path.join(DATA_DIR, `${id}.json`);
}

function readGist(id) {
  const p = gistPath(id);
  if (!p || !fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeGist(gist) {
  fs.writeFileSync(gistPath(gist.id), JSON.stringify(gist));
}

app.post("/gists", (req, res) => {
  const { filename = "share.json", description = "", content = "" } =
    req.body || {};
  const id = randomUUID();
  const now = new Date().toISOString();
  writeGist({
    id,
    description,
    files: { [filename]: { content } },
    created_at: now,
    updated_at: now,
  });
  res.json({ data: { id } });
});

app.get("/gists/:id", (req, res) => {
  const gist = readGist(req.params.id);
  if (!gist) return res.status(404).json({ error: "Not found" });
  // Agents update diagrams in place; embeds must always see the latest.
  res.setHeader("Cache-Control", "no-store");
  res.json({ data: gist });
});

app.patch("/gists/:id", (req, res) => {
  const gist = readGist(req.params.id);
  if (!gist) return res.status(404).json({ error: "Not found" });
  const { filename = "share.json", content = "" } = req.body || {};
  let deleted = false;
  if (content === "") {
    delete gist.files[filename];
    deleted = true;
    if (Object.keys(gist.files).length === 0) {
      fs.unlinkSync(gistPath(gist.id));
      return res.json({ deleted: true });
    }
  } else {
    gist.files[filename] = { content };
  }
  gist.updated_at = new Date().toISOString();
  writeGist(gist);
  res.json({ deleted });
});

app.delete("/gists/:id", (req, res) => {
  const p = gistPath(req.params.id);
  if (p && fs.existsSync(p)) fs.unlinkSync(p);
  res.json({ ok: true });
});

// Version-history endpoints the UI may call — we don't keep history; return
// empty sets so the UI renders "no versions" instead of erroring.
app.get("/gists/:id/commits", (_req, res) => res.json({ data: [] }));
app.get("/gists/:id/file-versions/:file", (_req, res) =>
  res.json({ data: { versions: [], cursor: null } }),
);
app.get("/gists/:id/file/:file/compare/:a/:b", (_req, res) =>
  res.json({ data: null }),
);
app.get("/gists/:id/:sha", (req, res) => {
  const gist = readGist(req.params.id);
  if (!gist) return res.status(404).json({ error: "Not found" });
  res.json({ data: gist });
});

// ---------------------------------------------------------------- agent API

const DB_ALIASES = {
  postgres: DB.POSTGRES,
  postgresql: DB.POSTGRES,
  pg: DB.POSTGRES,
  mysql: DB.MYSQL,
  mariadb: DB.MARIADB,
  mssql: DB.MSSQL,
  sqlserver: DB.MSSQL,
  transactsql: DB.MSSQL,
  sqlite: DB.SQLITE,
  oracle: DB.ORACLESQL,
  oraclesql: DB.ORACLESQL,
};

// POST /api/diagram
// body: { sql?: string, dbml?: string, database?: string, title?: string,
//         shareId?: string }
// resp: { ok, shareId, url, embedUrl, tables, relationships, updated }
// Passing an existing shareId overwrites that diagram in place — the share
// URL stays stable, so a chat embed of it shows the new version on reload.
// This is how agents iterate on a diagram unlimited times.
app.post("/api/diagram", (req, res) => {
  const {
    sql = "",
    dbml = "",
    database = "postgres",
    title = "Untitled diagram",
    shareId = "",
  } = req.body || {};

  if (!sql && !dbml) {
    return res
      .status(400)
      .json({ ok: false, error: "Provide `sql` or `dbml` in the body." });
  }

  const db = DB_ALIASES[String(database).toLowerCase()];
  if (!db) {
    return res.status(400).json({
      ok: false,
      error: `Unknown database "${database}". Use one of: ${Object.keys(DB_ALIASES).join(", ")}`,
    });
  }

  let diagram;
  try {
    if (dbml) {
      diagram = parseDbml(dbml);
      arrangeTables(diagram);
    } else {
      let ast;
      if (db === DB.ORACLESQL) {
        ast = new OracleParser().parse(sql);
      } else {
        ast = new Parser().astify(sql, { database: db });
      }
      diagram = importSQL(ast, db, db);
    }
  } catch (err) {
    // @dbml/core throws a CompilerError whose message lives in .diags
    const detail =
      err?.diags?.map((d) => d.message).join("; ") ||
      err?.message ||
      String(err);
    return res.status(422).json({
      ok: false,
      error: `Failed to parse ${dbml ? "DBML" : "SQL"}: ${detail}`,
    });
  }

  // transform.pan is the viewport CENTER (viewBox.left = pan.x - width/2),
  // so aim it at the middle of the arranged tables for a centered first view.
  const tables = diagram.tables || [];
  let pan = { x: 0, y: 0 };
  if (tables.length) {
    const xs = tables.map((t) => t.x);
    const ys = tables.map((t) => t.y);
    pan = {
      x: (Math.min(...xs) + Math.max(...xs)) / 2 + 110,
      y: (Math.min(...ys) + Math.max(...ys)) / 2 + 80,
    };
  }

  const content = JSON.stringify({
    title,
    tables,
    relationships: diagram.relationships || [],
    notes: [],
    subjectAreas: [],
    database: db,
    types: diagram.types || [],
    enums: diagram.enums || [],
    transform: { pan, zoom: 1 },
  });

  const now = new Date().toISOString();
  let id = randomUUID();
  let updated = false;
  if (shareId) {
    const existing = readGist(shareId);
    if (!existing) {
      return res.status(404).json({
        ok: false,
        error: `shareId ${shareId} not found — omit shareId to create a new diagram.`,
      });
    }
    id = existing.id;
    updated = true;
    existing.description = `Tandem Schema diagram: ${title}`;
    existing.files["share.json"] = { content };
    existing.updated_at = now;
    writeGist(existing);
  } else {
    writeGist({
      id,
      description: `Tandem Schema diagram: ${title}`,
      files: { "share.json": { content } },
      created_at: now,
      updated_at: now,
    });
  }

  res.json({
    ok: true,
    shareId: id,
    updated,
    url: `${PUBLIC_URL}/editor?shareId=${id}`,
    embedUrl: `${PUBLIC_URL}/editor?shareId=${id}&hideHeader=force&hideSidebar=force&hideToolbar=force&theme=dark`,
    tables: (diagram.tables || []).length,
    relationships: (diagram.relationships || []).length,
  });
});

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, service: "tandem-schema", version: "1.0.0" }),
);

// ------------------------------------------------- governed database pipeline

import {
  emitEvent,
  readEvents,
  requestApproval,
  grantApproval,
  getApproval,
  argusGovern,
  lintDiagram,
  roundTrip,
  rehearse,
  planMigration,
  pgExec,
  pgDump,
  dbExists,
  introspect,
} from "./pipeline.mjs";

function loadDiagram(shareId) {
  const gist = readGist(shareId);
  if (!gist) return null;
  try {
    return JSON.parse(gist.files["share.json"].content);
  } catch {
    return null;
  }
}

const DB_NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;

// POST /api/diagram/verify { shareId }
// Lint + round-trip + scratch rehearsal. Every step is reported to the room
// via pipeline events; the rehearsal DDL is governed by Argus first.
app.post("/api/diagram/verify", async (req, res) => {
  const { shareId = "" } = req.body || {};
  const diagram = loadDiagram(shareId);
  if (!diagram) return res.status(404).json({ ok: false, error: "Unknown shareId" });
  const title = diagram.title || shareId;

  const lint = lintDiagram(diagram);
  const lintErrors = lint.filter((i) => i.level === "error");
  emitEvent({ stage: "verify:lint", shareId, title, ok: lintErrors.length === 0, issues: lint });
  if (lintErrors.length > 0) {
    return res.json({ ok: false, stage: "lint", lint });
  }

  let rt;
  try {
    rt = roundTrip(diagram, diagram.database || "postgresql");
  } catch (err) {
    emitEvent({ stage: "verify:roundtrip", shareId, title, ok: false, error: err.message });
    return res.json({ ok: false, stage: "roundtrip", error: err.message });
  }
  emitEvent({ stage: "verify:roundtrip", shareId, title, ok: rt.ok, diffs: rt.diffs });
  if (!rt.ok) return res.json({ ok: false, stage: "roundtrip", diffs: rt.diffs });

  const decision = await argusGovern(rt.sql, { stage: "verify:rehearsal", shareId });
  emitEvent({ stage: "verify:govern", shareId, title, argus: decision });
  if (decision.decision !== "allow") {
    return res.status(403).json({ ok: false, stage: "argus", argus: decision });
  }

  let rehearsal;
  try {
    rehearsal = await rehearse(rt.sql, (diagram.tables || []).map((t) => t.name));
  } catch (err) {
    emitEvent({ stage: "verify:rehearsal", shareId, title, ok: false, error: err.message });
    return res.json({ ok: false, stage: "rehearsal", error: err.message });
  }
  emitEvent({ stage: "verify:rehearsal", shareId, title, ok: rehearsal.ok, rehearsal });

  const verified = rehearsal.ok;
  emitEvent({ stage: "verify:done", shareId, title, ok: verified });
  res.json({ ok: verified, lint, roundTrip: { ok: rt.ok }, rehearsal, argus: decision });
});

// POST /api/diagram/provision { shareId, name, env: "staging"|"prod" }
// Creates database app_<name>_<env> from the diagram. Prod requires an
// approval id from the room flow.
app.post("/api/diagram/provision", async (req, res) => {
  const { shareId = "", name = "", env = "staging", approvalId = "" } = req.body || {};
  const diagram = loadDiagram(shareId);
  if (!diagram) return res.status(404).json({ ok: false, error: "Unknown shareId" });
  if (!DB_NAME_RE.test(name)) return res.status(400).json({ ok: false, error: "name must match ^[a-z][a-z0-9_]{2,40}$" });
  if (!["staging", "prod"].includes(env)) return res.status(400).json({ ok: false, error: "env must be staging or prod" });
  const title = diagram.title || shareId;
  const dbName = `app_${name}_${env}`;

  if (env === "prod") {
    const approval = approvalId && getApproval(approvalId);
    if (!approval || approval.status !== "approved" || approval.detail?.dbName !== dbName) {
      const pending = requestApproval("provision-prod", { shareId, dbName, title });
      emitEvent({ stage: "provision:approval-needed", shareId, title, dbName, env, approval: pending });
      return res.status(403).json({
        ok: false,
        needsApproval: true,
        approvalId: pending.id,
        message: `Provisioning to PROD requires owner approval. Approve in the room with: approve ${pending.id}`,
      });
    }
  }

  const rt = roundTrip(diagram, diagram.database || "postgresql");
  if (!rt.ok) return res.status(422).json({ ok: false, error: "Diagram failed round-trip; run verify first", diffs: rt.diffs });

  const decision = await argusGovern(rt.sql, { stage: "provision", shareId, dbName, env });
  emitEvent({ stage: "provision:govern", shareId, title, dbName, env, argus: decision });
  if (decision.decision !== "allow") {
    return res.status(403).json({ ok: false, stage: "argus", argus: decision });
  }

  try {
    let backup = null;
    if (await dbExists(dbName)) {
      backup = await pgDump(dbName, "pre-provision");
      emitEvent({ stage: "provision:backup", shareId, dbName, env, backup });
    } else {
      await pgExec(["-c", `CREATE DATABASE ${dbName}`]);
    }
    await pgExec(["-d", dbName, "-v", "ON_ERROR_STOP=1"], rt.sql);
    const live = await introspect(dbName);
    emitEvent({ stage: "provision:done", shareId, title, dbName, env, ok: true, tables: Object.keys(live) });
    res.json({ ok: true, dbName, env, tables: Object.keys(live), backup, argus: decision });
  } catch (err) {
    emitEvent({ stage: "provision:failed", shareId, title, dbName, env, error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/diagram/migrate { shareId, name, env, approvalId? }
// Diffs the live database against the diagram. Additive changes apply after
// Argus allows them; destructive changes are blocked until an owner approval
// exists AND are individually submitted to Argus so the block/override is on
// the ledger.
app.post("/api/diagram/migrate", async (req, res) => {
  const { shareId = "", name = "", env = "staging", approvalId = "" } = req.body || {};
  const diagram = loadDiagram(shareId);
  if (!diagram) return res.status(404).json({ ok: false, error: "Unknown shareId" });
  if (!DB_NAME_RE.test(name)) return res.status(400).json({ ok: false, error: "bad name" });
  const dbName = `app_${name}_${env}`;
  const title = diagram.title || shareId;
  if (!(await dbExists(dbName))) return res.status(404).json({ ok: false, error: `${dbName} does not exist — provision first` });

  const live = await introspect(dbName);
  const plan = planMigration(live, diagram);
  emitEvent({ stage: "migrate:plan", shareId, title, dbName, env, additive: plan.additive, destructive: plan.destructive });

  if (plan.additive.length === 0 && plan.destructive.length === 0) {
    emitEvent({ stage: "migrate:done", shareId, title, dbName, env, ok: true, applied: [], note: "already in sync" });
    return res.json({ ok: true, applied: [], note: "Database already matches the diagram." });
  }

  // Destructive changes: Argus governs each (expected: block), then a human
  // approval is the only way through.
  if (plan.destructive.length > 0) {
    const decisions = [];
    for (const d of plan.destructive) {
      decisions.push({ ...d, argus: await argusGovern(d.sql, { stage: "migrate:destructive", shareId, dbName }) });
    }
    emitEvent({ stage: "migrate:destructive-governed", shareId, title, dbName, env, decisions });

    const approval = approvalId && getApproval(approvalId);
    if (!approval || approval.status !== "approved" || approval.detail?.dbName !== dbName) {
      const pending = requestApproval("migrate-destructive", {
        shareId, dbName, title,
        changes: plan.destructive.map((d) => ({ sql: d.sql, why: d.why })),
      });
      emitEvent({ stage: "migrate:approval-needed", shareId, title, dbName, env, approval: pending, destructive: plan.destructive });
      return res.status(403).json({
        ok: false,
        needsApproval: true,
        approvalId: pending.id,
        destructive: plan.destructive,
        additive: plan.additive,
        message: `Destructive changes blocked. Owner must approve in the room with: approve ${pending.id}`,
      });
    }
    emitEvent({ stage: "migrate:override", shareId, title, dbName, env, approval, note: "owner approved destructive changes" });
  }

  // Additive changes govern as a batch (expected: allow).
  const allSql = [...plan.additive, ...plan.destructive.map((d) => d.sql)];
  const decision = await argusGovern(plan.additive.join("; ") || "-- no additive changes", { stage: "migrate:additive", shareId, dbName });
  emitEvent({ stage: "migrate:govern", shareId, title, dbName, env, argus: decision });
  if (decision.decision !== "allow" && plan.additive.length > 0) {
    return res.status(403).json({ ok: false, stage: "argus", argus: decision });
  }

  try {
    const backup = await pgDump(dbName, "pre-migrate");
    emitEvent({ stage: "migrate:backup", shareId, dbName, env, backup });
    await pgExec(["-d", dbName, "-v", "ON_ERROR_STOP=1"], `BEGIN;\n${allSql.join(";\n")};\nCOMMIT;`);
    const after = await introspect(dbName);
    emitEvent({ stage: "migrate:done", shareId, title, dbName, env, ok: true, applied: allSql, tables: Object.keys(after) });
    res.json({ ok: true, applied: allSql, backup, tables: Object.keys(after) });
  } catch (err) {
    emitEvent({ stage: "migrate:failed", shareId, title, dbName, env, error: err.message });
    res.status(500).json({ ok: false, error: err.message, note: "transaction rolled back; backup on disk" });
  }
});

// Pipeline plumbing for the room watcher.
app.get("/api/pipeline/events", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, events: readEvents(req.query.since || null) });
});

app.post("/api/pipeline/approve", (req, res) => {
  const { approvalId = "", approvedBy = "owner" } = req.body || {};
  const approval = grantApproval(approvalId, approvedBy);
  if (!approval) return res.status(404).json({ ok: false, error: "Unknown approvalId" });
  emitEvent({ stage: "approval:granted", approval });
  res.json({ ok: true, approval });
});

// ---------------------------------------------------------------- static SPA

app.use(express.static(DIST_DIR));
app.get(/^\/(?!gists|api).*/, (_req, res) => {
  res.sendFile(path.join(DIST_DIR, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[tandem-schema] listening on :${PORT}, data in ${DATA_DIR}`);
});
