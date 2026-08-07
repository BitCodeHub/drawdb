import { useEffect } from "react";
import { Link } from "react-router-dom";
import SimpleCanvas from "../components/SimpleCanvas";
import { diagram } from "../data/heroDiagram";
import mysql_icon from "../assets/mysql.png";
import postgres_icon from "../assets/postgres.png";
import sqlite_icon from "../assets/sqlite.png";
import mariadb_icon from "../assets/mariadb.png";
import oraclesql_icon from "../assets/oraclesql.png";
import sql_server_icon from "../assets/sql-server.png";
import logo from "../assets/logo_light_160.png";
import FadeIn from "../animations/FadeIn";

const AMBER = "#FFAC02";
const FOREST = "#041C1B";
const SURFACE = "#0B201F";
const CREAM = "#F5F0DC";

export default function LandingPage() {
  useEffect(() => {
    document.body.setAttribute("theme-mode", "light");
    document.title =
      "Tandem Schema | Database diagram editor and SQL generator";
  }, []);

  return (
    <div
      className="flex flex-col min-h-screen"
      style={{ backgroundColor: FOREST, color: CREAM }}
    >
      {/* Header */}
      <FadeIn duration={0.6}>
        <div className="flex items-center justify-between px-6 md:px-12 py-5">
          <div className="flex items-center gap-3">
            <img src={logo} alt="Tandem Schema" className="h-9" />
            <span className="text-xl font-bold" style={{ color: CREAM }}>
              Tandem <span style={{ color: AMBER }}>Schema</span>
            </span>
          </div>
          <Link
            to="/editor"
            className="px-5 py-2 rounded-lg font-semibold transition-opacity hover:opacity-80"
            style={{ backgroundColor: AMBER, color: FOREST }}
          >
            Open Editor
          </Link>
        </div>
      </FadeIn>

      {/* Hero */}
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-12">
        <FadeIn duration={0.75}>
          <h1
            className="text-4xl md:text-6xl font-extrabold leading-tight max-w-3xl"
            style={{ color: CREAM }}
          >
            Design your database,{" "}
            <span style={{ color: AMBER }}>together with your agents.</span>
          </h1>
          <p
            className="mt-6 text-lg md:text-xl max-w-2xl mx-auto"
            style={{ color: "#B9C4B9" }}
          >
            Tandem Schema is the Tandem workspace&apos;s entity-relationship
            editor. Draw tables, import and export SQL, and let your AI
            teammates publish live diagrams straight into the conversation.
          </p>
          <div className="mt-8 flex items-center justify-center gap-4">
            <Link
              to="/editor"
              className="px-8 py-3 rounded-xl text-lg font-bold transition-opacity hover:opacity-80"
              style={{ backgroundColor: AMBER, color: FOREST }}
            >
              Start designing
            </Link>
            <Link
              to="/templates"
              className="px-8 py-3 rounded-xl text-lg font-semibold border transition-opacity hover:opacity-80"
              style={{ borderColor: "#5A6455", color: CREAM }}
            >
              Templates
            </Link>
          </div>
        </FadeIn>

        {/* Canvas preview */}
        <FadeIn duration={1}>
          <div
            className="mt-12 w-full max-w-5xl rounded-2xl overflow-hidden border"
            style={{ borderColor: "#5A6455", backgroundColor: SURFACE }}
          >
            <div className="h-105">
              <SimpleCanvas diagram={diagram} zoom={0.85} />
            </div>
          </div>
        </FadeIn>

        {/* Supported databases */}
        <FadeIn duration={1.2}>
          <div className="mt-12">
            <p
              className="text-sm uppercase tracking-widest mb-5"
              style={{ color: "#8A968A" }}
            >
              Import and export
            </p>
            <div className="flex flex-wrap items-center justify-center gap-8 opacity-90">
              <img src={mysql_icon} alt="MySQL" className="h-10" />
              <img src={postgres_icon} alt="PostgreSQL" className="h-10" />
              <img src={sqlite_icon} alt="SQLite" className="h-10" />
              <img src={mariadb_icon} alt="MariaDB" className="h-10" />
              <img src={sql_server_icon} alt="SQL Server" className="h-10" />
              <img src={oraclesql_icon} alt="Oracle" className="h-10" />
            </div>
          </div>
        </FadeIn>
      </div>

      {/* Footer */}
      <div
        className="text-center py-5 text-sm border-t"
        style={{ borderColor: "#1C2E2C", color: "#8A968A" }}
      >
        &copy; {new Date().getFullYear()} <strong>Tandem Schema</strong> · part
        of the Tandem workspace · built on open source (AGPL-3.0)
      </div>
    </div>
  );
}
