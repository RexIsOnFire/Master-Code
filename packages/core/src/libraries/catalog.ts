/**
 * The library catalogue.
 *
 * Two rules govern this whole subsystem:
 *
 *  1. **Nothing is downloaded.** Browsing, searching, adding to a project and
 *     writing the manifest are all offline operations. Adding `numpy` records
 *     `numpy` in `requirements.txt` and stops there. Fetching is a separate,
 *     explicit action that runs the language's own package manager - see
 *     `install.ts`.
 *  2. **The curated list is a starting point, not the boundary.** No offline
 *     list can be "every library"; the registries hold millions. So the
 *     catalogue below is a hand-picked set covering the common needs per
 *     language, and `registry.ts` searches the real index (PyPI, npm,
 *     crates.io, NuGet, Maven Central, the Go module proxy) when the user asks
 *     for something that is not in it and has a network connection.
 *
 * Versions are the latest known at the time of writing. They are a suggestion
 * the user can edit, never a constraint - and `mcode libs outdated` compares
 * them against the live registry rather than pretending this file is current.
 */

export interface LibraryEntry {
  /** Package name exactly as the native manager knows it. */
  name: string;
  language: string;
  /** `pip`, `npm`, `nuget`, `maven`, `cargo`, `gomod`, `vcpkg`, `cdn`. */
  manager: string;
  /** Latest version known when this catalogue was written. */
  version: string;
  summary: string;
  categories: string[];
  license: string;
  homepage: string;
  /** Import or `using` line the user will most likely need. */
  importHint?: string;
  /** Packages that must be present too. */
  peers?: string[];
  /** Flags a library that pulls a large native toolchain or big download. */
  heavy?: boolean;
}

function e(
  name: string,
  version: string,
  summary: string,
  categories: string[],
  license: string,
  homepage: string,
  extra: Partial<LibraryEntry> = {},
): Omit<LibraryEntry, 'language' | 'manager'> {
  return { name, version, summary, categories, license, homepage, ...extra };
}

// ---------------------------------------------------------------------------
// Python (pip)
// ---------------------------------------------------------------------------

const PYTHON = [
  e('requests', '2.32.3', 'HTTP client with a friendly API.', ['http', 'network'], 'Apache-2.0', 'https://requests.readthedocs.io', { importHint: 'import requests' }),
  e('httpx', '0.27.2', 'HTTP client with sync and async support.', ['http', 'network', 'async'], 'BSD-3-Clause', 'https://www.python-httpx.org'),
  e('aiohttp', '3.10.10', 'Async HTTP client and server.', ['http', 'async', 'web'], 'Apache-2.0', 'https://docs.aiohttp.org'),
  e('flask', '3.0.3', 'Small web framework for services and APIs.', ['web', 'api'], 'BSD-3-Clause', 'https://flask.palletsprojects.com', { importHint: 'from flask import Flask' }),
  e('fastapi', '0.115.4', 'Typed async web framework with generated OpenAPI docs.', ['web', 'api', 'async'], 'MIT', 'https://fastapi.tiangolo.com', { peers: ['uvicorn'] }),
  e('django', '5.1.3', 'Batteries-included web framework with an ORM and admin.', ['web', 'orm', 'api'], 'BSD-3-Clause', 'https://www.djangoproject.com', { heavy: true }),
  e('uvicorn', '0.32.0', 'ASGI server for FastAPI and Starlette.', ['web', 'server'], 'BSD-3-Clause', 'https://www.uvicorn.org'),
  e('pydantic', '2.9.2', 'Data validation from type annotations.', ['validation', 'data'], 'MIT', 'https://docs.pydantic.dev'),
  e('sqlalchemy', '2.0.36', 'SQL toolkit and ORM.', ['database', 'orm'], 'MIT', 'https://www.sqlalchemy.org'),
  e('psycopg[binary]', '3.2.3', 'PostgreSQL driver.', ['database'], 'LGPL-3.0', 'https://www.psycopg.org'),
  e('numpy', '2.1.3', 'N-dimensional arrays and numerical routines.', ['math', 'data', 'science'], 'BSD-3-Clause', 'https://numpy.org', { importHint: 'import numpy as np' }),
  e('pandas', '2.2.3', 'Data frames for tabular analysis.', ['data', 'science'], 'BSD-3-Clause', 'https://pandas.pydata.org', { importHint: 'import pandas as pd', heavy: true }),
  e('scipy', '1.14.1', 'Scientific computing: optimisation, signals, statistics.', ['math', 'science'], 'BSD-3-Clause', 'https://scipy.org', { heavy: true }),
  e('matplotlib', '3.9.2', 'Plotting and charting.', ['visualisation', 'science'], 'PSF-2.0', 'https://matplotlib.org', { heavy: true }),
  e('polars', '1.12.0', 'Fast data frames built on Arrow.', ['data'], 'MIT', 'https://pola.rs'),
  e('pillow', '11.0.0', 'Image reading, writing and manipulation.', ['image', 'media'], 'MIT-CMU', 'https://python-pillow.org'),
  e('rich', '13.9.4', 'Rich text, tables and progress bars in the terminal.', ['cli', 'display'], 'MIT', 'https://rich.readthedocs.io'),
  e('typer', '0.12.5', 'Command-line interfaces from type annotations.', ['cli'], 'MIT', 'https://typer.tiangolo.com'),
  e('click', '8.1.7', 'Composable command-line interfaces.', ['cli'], 'BSD-3-Clause', 'https://click.palletsprojects.com'),
  e('pytest', '8.3.3', 'Testing framework.', ['testing'], 'MIT', 'https://pytest.org'),
  e('hypothesis', '6.119.0', 'Property-based testing.', ['testing'], 'MPL-2.0', 'https://hypothesis.works'),
  e('ruff', '0.7.3', 'Fast linter and formatter.', ['tooling', 'lint'], 'MIT', 'https://docs.astral.sh/ruff'),
  e('mypy', '1.13.0', 'Static type checker.', ['tooling', 'types'], 'MIT', 'https://mypy-lang.org'),
  e('python-dotenv', '1.0.1', 'Load configuration from a .env file.', ['config'], 'BSD-3-Clause', 'https://github.com/theskumar/python-dotenv'),
  e('pyyaml', '6.0.2', 'YAML parsing and serialisation.', ['serialisation', 'config'], 'MIT', 'https://pyyaml.org'),
  e('jinja2', '3.1.4', 'Template engine.', ['template', 'web'], 'BSD-3-Clause', 'https://jinja.palletsprojects.com'),
  e('beautifulsoup4', '4.12.3', 'HTML and XML parsing.', ['parsing', 'web'], 'MIT', 'https://www.crummy.com/software/BeautifulSoup/'),
  e('cryptography', '43.0.3', 'Cryptographic primitives and recipes.', ['crypto', 'security'], 'Apache-2.0', 'https://cryptography.io'),
  e('boto3', '1.35.54', 'AWS SDK for S3, DynamoDB and the rest of the AWS API.', ['cloud'], 'Apache-2.0', 'https://boto3.amazonaws.com', { heavy: true }),
  e('redis', '5.2.0', 'Redis client.', ['database', 'cache'], 'MIT', 'https://redis-py.readthedocs.io'),
  e('celery', '5.4.0', 'Distributed task queue.', ['queue', 'async'], 'BSD-3-Clause', 'https://docs.celeryq.dev'),
  e('scikit-learn', '1.5.2', 'Classical machine learning.', ['ml', 'science'], 'BSD-3-Clause', 'https://scikit-learn.org', { heavy: true }),
  e('textual', '0.85.2', 'Terminal user interfaces.', ['cli', 'ui'], 'MIT', 'https://textual.textualize.io'),
  e('pyqt6', '6.7.1', 'Qt bindings for desktop applications.', ['ui', 'desktop'], 'GPL-3.0', 'https://www.riverbankcomputing.com/software/pyqt/', { heavy: true }),
  e('websockets', '13.1', 'WebSocket client and server.', ['network', 'async'], 'BSD-3-Clause', 'https://websockets.readthedocs.io'),
  e('orjson', '3.10.11', 'Fast JSON serialisation.', ['serialisation'], 'Apache-2.0', 'https://github.com/ijl/orjson'),
];

// ---------------------------------------------------------------------------
// JavaScript (npm)
// ---------------------------------------------------------------------------

const JAVASCRIPT = [
  e('express', '4.21.1', 'Minimal HTTP server framework.', ['web', 'api', 'server'], 'MIT', 'https://expressjs.com'),
  e('fastify', '5.1.0', 'Fast HTTP server framework with schema validation.', ['web', 'api', 'server'], 'MIT', 'https://fastify.dev'),
  e('hono', '4.6.9', 'Small web framework that runs on any JS runtime.', ['web', 'api'], 'MIT', 'https://hono.dev'),
  e('zod', '3.23.8', 'Schema declaration and validation.', ['validation', 'types'], 'MIT', 'https://zod.dev'),
  e('axios', '1.7.7', 'HTTP client for browser and Node.', ['http', 'network'], 'MIT', 'https://axios-http.com'),
  e('ws', '8.18.0', 'WebSocket client and server.', ['network'], 'MIT', 'https://github.com/websockets/ws'),
  e('react', '18.3.1', 'Component-based UI library.', ['ui', 'frontend'], 'MIT', 'https://react.dev', { peers: ['react-dom'] }),
  e('react-dom', '18.3.1', 'React renderer for the DOM.', ['ui', 'frontend'], 'MIT', 'https://react.dev'),
  e('vue', '3.5.12', 'Progressive UI framework.', ['ui', 'frontend'], 'MIT', 'https://vuejs.org'),
  e('svelte', '5.1.13', 'Compiler-based UI framework.', ['ui', 'frontend'], 'MIT', 'https://svelte.dev'),
  e('lit', '3.2.1', 'Web components with reactive properties.', ['ui', 'frontend'], 'BSD-3-Clause', 'https://lit.dev'),
  e('d3', '7.9.0', 'Data-driven documents: low-level charting and visualisation primitives.', ['visualisation', 'frontend'], 'ISC', 'https://d3js.org'),
  e('chart.js', '4.4.6', 'Canvas charting.', ['visualisation', 'frontend'], 'MIT', 'https://www.chartjs.org'),
  e('three', '0.170.0', '3D rendering with WebGL.', ['graphics', '3d'], 'MIT', 'https://threejs.org', { heavy: true }),
  e('lodash', '4.17.21', 'Utility functions for arrays, objects and functions.', ['utility'], 'MIT', 'https://lodash.com'),
  e('date-fns', '4.1.0', 'Date manipulation.', ['utility', 'time'], 'MIT', 'https://date-fns.org'),
  e('dayjs', '1.11.13', 'Small date library with a Moment-like API.', ['utility', 'time'], 'MIT', 'https://day.js.org'),
  e('drizzle-orm', '0.36.1', 'Typed SQL query builder and ORM.', ['database', 'orm'], 'Apache-2.0', 'https://orm.drizzle.team'),
  e('better-sqlite3', '11.5.0', 'Synchronous SQLite bindings.', ['database'], 'MIT', 'https://github.com/WiseLibs/better-sqlite3'),
  e('pg', '8.13.1', 'PostgreSQL client.', ['database'], 'MIT', 'https://node-postgres.com'),
  e('ioredis', '5.4.1', 'Redis client.', ['database', 'cache'], 'MIT', 'https://github.com/redis/ioredis'),
  e('commander', '12.1.0', 'Command-line argument parsing.', ['cli'], 'MIT', 'https://github.com/tj/commander.js'),
  e('chalk', '5.3.0', 'Terminal colour.', ['cli', 'display'], 'MIT', 'https://github.com/chalk/chalk'),
  e('vitest', '2.1.4', 'Test runner with a Jest-compatible API.', ['testing'], 'MIT', 'https://vitest.dev'),
  e('playwright', '1.48.2', 'Browser automation and end-to-end testing.', ['testing', 'automation'], 'Apache-2.0', 'https://playwright.dev', { heavy: true }),
  e('eslint', '9.14.0', 'Configurable linter for JavaScript and TypeScript.', ['tooling', 'lint'], 'MIT', 'https://eslint.org'),
  e('prettier', '3.3.3', 'Opinionated code formatter.', ['tooling', 'format'], 'MIT', 'https://prettier.io'),
  e('typescript', '5.6.3', 'Typed superset of JavaScript.', ['tooling', 'types'], 'Apache-2.0', 'https://www.typescriptlang.org'),
  e('vite', '5.4.10', 'Dev server and bundler.', ['tooling', 'build'], 'MIT', 'https://vite.dev'),
  e('esbuild', '0.24.0', 'Very fast bundler and minifier.', ['tooling', 'build'], 'MIT', 'https://esbuild.github.io'),
  e('sharp', '0.33.5', 'Fast image processing.', ['image', 'media'], 'Apache-2.0', 'https://sharp.pixelplumbing.com', { heavy: true }),
  e('marked', '14.1.3', 'Markdown parser.', ['parsing', 'text'], 'MIT', 'https://marked.js.org'),
  e('uuid', '11.0.2', 'RFC-compliant UUID generation.', ['utility'], 'MIT', 'https://github.com/uuidjs/uuid'),
  e('dotenv', '16.4.5', 'Load configuration from a .env file.', ['config'], 'BSD-2-Clause', 'https://github.com/motdotla/dotenv'),
];

// ---------------------------------------------------------------------------
// Java (Maven coordinates)
// ---------------------------------------------------------------------------

const JAVA = [
  e('org.springframework.boot:spring-boot-starter-web', '3.3.5', 'Spring Boot web and REST starter.', ['web', 'api'], 'Apache-2.0', 'https://spring.io/projects/spring-boot', { heavy: true }),
  e('com.fasterxml.jackson.core:jackson-databind', '2.18.1', 'JSON serialisation and binding.', ['serialisation', 'json'], 'Apache-2.0', 'https://github.com/FasterXML/jackson'),
  e('com.google.code.gson:gson', '2.11.0', 'Small JSON library.', ['serialisation', 'json'], 'Apache-2.0', 'https://github.com/google/gson'),
  e('org.xerial:sqlite-jdbc', '3.47.0.0', 'SQLite JDBC driver. Needed by the Database nodes.', ['database'], 'Apache-2.0', 'https://github.com/xerial/sqlite-jdbc'),
  e('org.postgresql:postgresql', '42.7.4', 'PostgreSQL JDBC driver.', ['database'], 'BSD-2-Clause', 'https://jdbc.postgresql.org'),
  e('org.junit.jupiter:junit-jupiter', '5.11.3', 'JUnit 5 testing framework.', ['testing'], 'EPL-2.0', 'https://junit.org/junit5/'),
  e('org.assertj:assertj-core', '3.26.3', 'Fluent assertions.', ['testing'], 'Apache-2.0', 'https://assertj.github.io/doc/'),
  e('com.squareup.okhttp3:okhttp', '4.12.0', 'HTTP client.', ['http', 'network'], 'Apache-2.0', 'https://square.github.io/okhttp/'),
  e('org.apache.commons:commons-lang3', '3.17.0', 'General-purpose utilities.', ['utility'], 'Apache-2.0', 'https://commons.apache.org/proper/commons-lang/'),
  e('com.google.guava:guava', '33.3.1-jre', 'Collections, caching and concurrency utilities.', ['utility'], 'Apache-2.0', 'https://github.com/google/guava'),
  e('org.slf4j:slf4j-api', '2.0.16', 'Logging facade.', ['logging'], 'MIT', 'https://www.slf4j.org'),
  e('ch.qos.logback:logback-classic', '1.5.12', 'Logging implementation for SLF4J.', ['logging'], 'EPL-1.0', 'https://logback.qos.ch'),
  e('org.projectlombok:lombok', '1.18.34', 'Annotation-driven boilerplate removal.', ['tooling'], 'MIT', 'https://projectlombok.org'),
  e('org.hibernate.orm:hibernate-core', '6.6.2.Final', 'JPA ORM implementation.', ['database', 'orm'], 'LGPL-2.1', 'https://hibernate.org', { heavy: true }),
];

// ---------------------------------------------------------------------------
// C# (NuGet)
// ---------------------------------------------------------------------------

const CSHARP = [
  e('Newtonsoft.Json', '13.0.3', 'JSON serialisation.', ['serialisation', 'json'], 'MIT', 'https://www.newtonsoft.com/json'),
  e('Microsoft.Data.Sqlite', '9.0.0', 'SQLite provider. Needed by the Database nodes.', ['database'], 'MIT', 'https://learn.microsoft.com/dotnet/standard/data/sqlite/'),
  e('Npgsql', '8.0.5', 'PostgreSQL provider.', ['database'], 'PostgreSQL', 'https://www.npgsql.org'),
  e('Dapper', '2.1.35', 'Lightweight object mapper for ADO.NET.', ['database', 'orm'], 'Apache-2.0', 'https://github.com/DapperLib/Dapper'),
  e('Microsoft.EntityFrameworkCore', '9.0.0', 'ORM with LINQ queries and migrations.', ['database', 'orm'], 'MIT', 'https://learn.microsoft.com/ef/core/', { heavy: true }),
  e('Serilog', '4.1.0', 'Structured logging.', ['logging'], 'Apache-2.0', 'https://serilog.net'),
  e('xunit', '2.9.2', 'Testing framework.', ['testing'], 'Apache-2.0', 'https://xunit.net'),
  e('FluentAssertions', '6.12.2', 'Fluent assertions.', ['testing'], 'Apache-2.0', 'https://fluentassertions.com'),
  e('Polly', '8.5.0', 'Retry, circuit breaker and other resilience policies.', ['resilience', 'network'], 'BSD-3-Clause', 'https://www.pollydocs.org'),
  e('CommandLineParser', '2.9.1', 'Command-line argument parsing.', ['cli'], 'MIT', 'https://github.com/commandlineparser/commandline'),
  e('Spectre.Console', '0.49.1', 'Rich terminal output: tables, prompts, progress.', ['cli', 'display'], 'MIT', 'https://spectreconsole.net'),
  e('AutoMapper', '13.0.1', 'Object-to-object mapping.', ['utility'], 'MIT', 'https://automapper.org'),
  e('Avalonia', '11.2.1', 'Cross-platform desktop UI framework.', ['ui', 'desktop'], 'MIT', 'https://avaloniaui.net', { heavy: true }),
];

// ---------------------------------------------------------------------------
// Rust (crates.io)
// ---------------------------------------------------------------------------

const RUST = [
  e('serde', '1.0.215', 'Serialisation framework.', ['serialisation'], 'MIT OR Apache-2.0', 'https://serde.rs', { peers: ['serde_json'] }),
  e('serde_json', '1.0.132', 'JSON support for serde.', ['serialisation', 'json'], 'MIT OR Apache-2.0', 'https://github.com/serde-rs/json'),
  e('tokio', '1.41.1', 'Async runtime.', ['async', 'runtime'], 'MIT', 'https://tokio.rs'),
  e('reqwest', '0.12.9', 'HTTP client.', ['http', 'network'], 'MIT OR Apache-2.0', 'https://github.com/seanmonstar/reqwest'),
  e('axum', '0.7.9', 'Web framework built on tokio and tower.', ['web', 'api'], 'MIT', 'https://github.com/tokio-rs/axum'),
  e('actix-web', '4.9.0', 'Fast web framework.', ['web', 'api'], 'MIT OR Apache-2.0', 'https://actix.rs'),
  e('clap', '4.5.20', 'Command-line argument parsing.', ['cli'], 'MIT OR Apache-2.0', 'https://docs.rs/clap'),
  e('anyhow', '1.0.93', 'Flexible error type for applications.', ['error'], 'MIT OR Apache-2.0', 'https://docs.rs/anyhow'),
  e('thiserror', '2.0.3', 'Derive macro for library error types.', ['error'], 'MIT OR Apache-2.0', 'https://docs.rs/thiserror'),
  e('rusqlite', '0.32.1', 'SQLite bindings.', ['database'], 'MIT', 'https://docs.rs/rusqlite'),
  e('sqlx', '0.8.2', 'Async SQL toolkit with compile-time checked queries.', ['database'], 'MIT OR Apache-2.0', 'https://github.com/launchbadge/sqlx'),
  e('rayon', '1.10.0', 'Data parallelism.', ['concurrency'], 'MIT OR Apache-2.0', 'https://docs.rs/rayon'),
  e('regex', '1.11.1', 'Regular expressions.', ['text', 'parsing'], 'MIT OR Apache-2.0', 'https://docs.rs/regex'),
  e('chrono', '0.4.38', 'Dates and times.', ['time'], 'MIT OR Apache-2.0', 'https://docs.rs/chrono'),
  e('tracing', '0.1.40', 'Structured, async-aware diagnostics.', ['logging'], 'MIT', 'https://docs.rs/tracing'),
  e('itertools', '0.13.0', 'Extra iterator adaptors.', ['utility'], 'MIT OR Apache-2.0', 'https://docs.rs/itertools'),
];

// ---------------------------------------------------------------------------
// Go (module paths)
// ---------------------------------------------------------------------------

const GO = [
  e('github.com/gin-gonic/gin', 'v1.10.0', 'HTTP web framework.', ['web', 'api'], 'MIT', 'https://gin-gonic.com'),
  e('github.com/labstack/echo/v4', 'v4.12.0', 'Minimal, fast web framework.', ['web', 'api'], 'MIT', 'https://echo.labstack.com'),
  e('github.com/go-chi/chi/v5', 'v5.1.0', 'Composable HTTP router.', ['web', 'api'], 'MIT', 'https://go-chi.io'),
  e('github.com/spf13/cobra', 'v1.8.1', 'Command-line applications with subcommands.', ['cli'], 'Apache-2.0', 'https://cobra.dev'),
  e('github.com/spf13/viper', 'v1.19.0', 'Configuration from files, env and flags.', ['config'], 'MIT', 'https://github.com/spf13/viper'),
  e('github.com/mattn/go-sqlite3', 'v1.14.24', 'SQLite driver (cgo).', ['database'], 'MIT', 'https://github.com/mattn/go-sqlite3'),
  e('github.com/jackc/pgx/v5', 'v5.7.1', 'PostgreSQL driver and toolkit.', ['database'], 'MIT', 'https://github.com/jackc/pgx'),
  e('gorm.io/gorm', 'v1.25.12', 'ORM with migrations, associations and hooks.', ['database', 'orm'], 'MIT', 'https://gorm.io'),
  e('github.com/stretchr/testify', 'v1.9.0', 'Assertions and mocks for tests.', ['testing'], 'MIT', 'https://github.com/stretchr/testify'),
  e('go.uber.org/zap', 'v1.27.0', 'Structured, fast logging.', ['logging'], 'MIT', 'https://github.com/uber-go/zap'),
  e('github.com/google/uuid', 'v1.6.0', 'UUID generation.', ['utility'], 'BSD-3-Clause', 'https://github.com/google/uuid'),
  e('golang.org/x/sync', 'v0.9.0', 'Errgroup, semaphore and other sync primitives.', ['concurrency'], 'BSD-3-Clause', 'https://pkg.go.dev/golang.org/x/sync'),
];

// ---------------------------------------------------------------------------
// C and C++ (vcpkg port names)
// ---------------------------------------------------------------------------

const CPP = [
  e('fmt', '11.0.2', 'Formatting library; the basis of std::format.', ['text', 'utility'], 'MIT', 'https://fmt.dev'),
  e('nlohmann-json', '3.11.3', 'JSON for modern C++.', ['serialisation', 'json'], 'MIT', 'https://json.nlohmann.me'),
  e('spdlog', '1.14.1', 'Fast logging.', ['logging'], 'MIT', 'https://github.com/gabime/spdlog'),
  e('catch2', '3.7.1', 'Testing framework.', ['testing'], 'BSL-1.0', 'https://github.com/catchorg/Catch2'),
  e('gtest', '1.15.2', 'GoogleTest and GoogleMock.', ['testing'], 'BSD-3-Clause', 'https://google.github.io/googletest/'),
  e('cpr', '1.11.0', 'HTTP client with a requests-like API.', ['http', 'network'], 'MIT', 'https://docs.libcpr.org'),
  e('eigen3', '3.4.0', 'Linear algebra.', ['math'], 'MPL-2.0', 'https://eigen.tuxfamily.org'),
  e('boost', '1.86.0', 'Large general-purpose library collection.', ['utility'], 'BSL-1.0', 'https://www.boost.org', { heavy: true }),
  e('sqlite3', '3.47.0', 'Embedded SQL database engine.', ['database'], 'Public Domain', 'https://sqlite.org'),
  e('sdl2', '2.30.9', 'Windowing, input and audio.', ['graphics', 'games'], 'Zlib', 'https://www.libsdl.org'),
  e('imgui', '1.91.5', 'Immediate-mode GUI.', ['ui', 'graphics'], 'MIT', 'https://github.com/ocornut/imgui'),
];

const C_LIBS = [
  e('sqlite3', '3.47.0', 'Embedded SQL database engine.', ['database'], 'Public Domain', 'https://sqlite.org'),
  e('curl', '8.10.1', 'HTTP and multi-protocol transfer library.', ['http', 'network'], 'curl', 'https://curl.se'),
  e('cjson', '1.7.18', 'Small JSON parser.', ['serialisation', 'json'], 'MIT', 'https://github.com/DaveGamble/cJSON'),
  e('zlib', '1.3.1', 'Compression.', ['compression'], 'Zlib', 'https://zlib.net'),
  e('openssl', '3.4.0', 'TLS and cryptography.', ['crypto', 'security'], 'Apache-2.0', 'https://www.openssl.org', { heavy: true }),
  e('libuv', '1.49.2', 'Cross-platform async I/O.', ['async', 'network'], 'MIT', 'https://libuv.org'),
  e('raylib', '5.0', 'Simple games and graphics programming.', ['graphics', 'games'], 'Zlib', 'https://www.raylib.com'),
];

// ---------------------------------------------------------------------------
// Front-end assets loaded by a page rather than installed (CDN)
// ---------------------------------------------------------------------------

const CDN = [
  e('htmx.org', '2.0.3', 'HTML-driven interactivity with no build step.', ['frontend', 'ui'], 'BSD-2-Clause', 'https://htmx.org'),
  e('alpinejs', '3.14.3', 'Small declarative behaviour for markup.', ['frontend', 'ui'], 'MIT', 'https://alpinejs.dev'),
  e('normalize.css', '8.0.1', 'Cross-browser style baseline.', ['frontend', 'css'], 'MIT', 'https://necolas.github.io/normalize.css/'),
  e('water.css', '2.1.1', 'Classless stylesheet for plain HTML.', ['frontend', 'css'], 'MIT', 'https://watercss.kognise.dev'),
  e('chart.js', '4.4.6', 'Canvas charting, loadable from a CDN.', ['frontend', 'visualisation'], 'MIT', 'https://www.chartjs.org'),
];

// ---------------------------------------------------------------------------

function withLanguage(
  entries: ReturnType<typeof e>[],
  language: string,
  manager: string,
): LibraryEntry[] {
  return entries.map((x) => ({ ...x, language, manager }));
}

export const CATALOG: LibraryEntry[] = [
  ...withLanguage(PYTHON, 'python', 'pip'),
  ...withLanguage(JAVASCRIPT, 'javascript', 'npm'),
  ...withLanguage(JAVA, 'java', 'maven'),
  ...withLanguage(CSHARP, 'csharp', 'nuget'),
  ...withLanguage(RUST, 'rust', 'cargo'),
  ...withLanguage(GO, 'go', 'gomod'),
  ...withLanguage(CPP, 'cpp', 'vcpkg'),
  ...withLanguage(C_LIBS, 'c', 'vcpkg'),
  ...withLanguage(CDN, 'html', 'cdn'),
];

export function catalogFor(language: string): LibraryEntry[] {
  return CATALOG.filter((l) => l.language === language).sort((a, b) => a.name.localeCompare(b.name));
}

export function categoriesFor(language?: string): string[] {
  const pool = language ? catalogFor(language) : CATALOG;
  return [...new Set(pool.flatMap((l) => l.categories))].sort();
}

export function findLibrary(language: string, name: string): LibraryEntry | undefined {
  const target = name.toLowerCase();
  return CATALOG.find((l) => l.language === language && l.name.toLowerCase() === target);
}

/** Offline search across the curated catalogue. */
export function searchCatalog(
  query: string,
  options: { language?: string; category?: string; limit?: number } = {},
): LibraryEntry[] {
  const q = query.trim().toLowerCase();
  let pool = options.language ? catalogFor(options.language) : CATALOG;
  if (options.category) pool = pool.filter((l) => l.categories.includes(options.category!));
  if (!q) return pool.slice(0, options.limit ?? pool.length);

  const scored = pool
    .map((entry) => {
      const name = entry.name.toLowerCase();
      let score = 0;
      if (name === q) score = 100;
      else if (name.startsWith(q)) score = 70;
      else if (name.includes(q)) score = 50;
      else if (entry.categories.some((c) => c.includes(q))) score = 30;
      else if (entry.summary.toLowerCase().includes(q)) score = 15;
      return { entry, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));

  return scored.slice(0, options.limit ?? scored.length).map((x) => x.entry);
}

/** Languages with curated entries, and how many each has. */
export function catalogSummary(): { language: string; count: number; manager: string }[] {
  const byLanguage = new Map<string, { count: number; manager: string }>();
  for (const entry of CATALOG) {
    const current = byLanguage.get(entry.language);
    if (current) current.count++;
    else byLanguage.set(entry.language, { count: 1, manager: entry.manager });
  }
  return [...byLanguage.entries()]
    .map(([language, info]) => ({ language, ...info }))
    .sort((a, b) => a.language.localeCompare(b.language));
}
