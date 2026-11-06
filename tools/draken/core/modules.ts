/**
 * The module platform: manifests, validation, and lifecycle.
 *
 * A module is metadata - a versioned manifest naming the capabilities it asks
 * for and the tools it offers - bound to *trusted handlers* that ship inside
 * the app. A package can declare tools only over handlers the platform marks
 * as available to packages; it cannot bring code. Nothing here is a sandbox,
 * and the docs do not pretend otherwise: the isolation is that a package has
 * no code to run, and every action still passes the permission broker.
 */

import type { Ctx } from '../kit.ts';
import { KtFile, kt } from '../kit.ts';

const ROOT = 'core/src/main/kotlin/com/draken/core/modules';

export function buildModules(ctx: Ctx): void {
  manifest(ctx);
  validation(ctx);
  manager(ctx);
}

function manifest(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/ModuleManifest.kt`, { doc: 'the module manifest format' });

  f.decl(
    kt`
      /** The manifest schema this build reads. */
      const val MANIFEST_SCHEMA_VERSION = 1L

      /** The platform API level modules are checked against. Raised when what modules can rely on changes. */
      const val MODULE_PLATFORM_VERSION = 1L
    `,
    { doc: 'Versions modules are checked against.', provides: ['MANIFEST_SCHEMA_VERSION', 'MODULE_PLATFORM_VERSION'] },
  );

  f.record(
    'CapabilityRequest',
    [
      { name: 'id', type: 'string' },
      { name: 'reason', type: 'string', doc: 'Why the module needs it, shown when the user decides.' },
    ],
    { doc: 'A capability a module asks for.', annotations: ['Serializable'] },
  );

  f.record(
    'ToolDeclaration',
    [
      { name: 'id', type: 'string', doc: 'Prefixed with the module id: draken.notes.create.' },
      { name: 'title', type: 'string' },
      { name: 'description', type: 'string' },
      { name: 'inputSchema', type: 'JsonObject' },
      { name: 'capability', type: 'string', doc: 'Must be one the module requests.' },
      { name: 'risk', type: 'RiskLevel' },
      { name: 'requiresConfirmation', type: 'bool', default: 'false' },
      { name: 'handler', type: 'string', doc: 'The trusted handler that implements it.' },
    ],
    { doc: 'A tool a module offers.', annotations: ['Serializable'] },
  );

  f.record(
    'ModuleDependency',
    [
      { name: 'id', type: 'string' },
      { name: 'minVersion', type: 'string' },
    ],
    { doc: 'Another module this one needs, at a minimum version.', annotations: ['Serializable'] },
  );

  f.record(
    'ModuleManifest',
    [
      { name: 'schemaVersion', type: 'i64' },
      { name: 'id', type: 'string', doc: 'Reverse-domain style, lower case: draken.notes.' },
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string', doc: 'Semantic version, MAJOR.MINOR.PATCH.' },
      { name: 'description', type: 'string' },
      { name: 'publisher', type: 'string' },
      { name: 'minPlatformVersion', type: 'i64', default: '1L' },
      { name: 'capabilities', type: 'List<CapabilityRequest>', default: 'emptyList()' },
      { name: 'tools', type: 'List<ToolDeclaration>', default: 'emptyList()' },
      { name: 'dependencies', type: 'List<ModuleDependency>', default: 'emptyList()' },
    ],
    { doc: 'Everything a module is, as data.', annotations: ['Serializable'] },
  );

  f.enm('ModuleSource', ['BUILT_IN', 'PACKAGE'], {
    doc: 'Where a module came from. Built-in modules ship with the app and cannot be removed, only turned off.',
  });

  f.record(
    'InstalledModule',
    [
      { name: 'manifest', type: 'ModuleManifest' },
      { name: 'enabled', type: 'bool' },
      { name: 'source', type: 'ModuleSource' },
      { name: 'installedAt', type: 'i64' },
    ],
    { doc: 'A module as installed on this device.' },
  );

  f.enm(
    'ManifestParse',
    [
      { name: 'Read', payload: [{ name: 'manifest', type: 'ModuleManifest' }] },
      { name: 'Unreadable', payload: [{ name: 'reason', type: 'string' }] },
    ],
    { doc: 'A manifest read from text, or why it could not be.' },
  );

  f.fn('parseManifest', {
    doc: 'A manifest from JSON text. Reading is not accepting: validation is a separate step.',
    params: [{ name: 'text', type: 'string' }],
    returns: 'ManifestParse',
    code: kt`
      return try {
          ManifestParse.Read(DrakenJson.format.decodeFromString(ModuleManifest.serializer(), text))
      } catch (failure: SerializationException) {
          ManifestParse.Unreadable(failure.message ?: "not a module manifest")
      } catch (failure: IllegalArgumentException) {
          ManifestParse.Unreadable(failure.message ?: "not a module manifest")
      }
    `,
  });
}

function validation(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/ManifestValidation.kt`, { doc: 'manifest validation' });

  f.record(
    'ManifestProblem',
    [
      { name: 'field', type: 'string' },
      { name: 'message', type: 'string' },
    ],
    { doc: 'One reason a manifest is not acceptable.' },
  );

  f.record(
    'HandlerBinding',
    [
      { name: 'handler', type: 'ToolHandler' },
      {
        name: 'availableToPackages',
        type: 'bool',
        doc: 'Whether a package - not just a built-in module - may declare a tool over it.',
      },
    ],
    { doc: 'A trusted handler and who may use it.' },
  );

  f.cls('HandlerCatalog', {
    doc: 'The trusted tool implementations this build ships, by handler id.',
    fields: [{ name: 'bindings', type: 'MutableMap<string, HandlerBinding>', default: 'mutableMapOf()', visibility: 'private' }],
  });
  f.fn('add', {
    of: 'HandlerCatalog',
    doc: 'Make a handler available.',
    params: [
      { name: 'id', type: 'string' },
      { name: 'handler', type: 'ToolHandler' },
      { name: 'availableToPackages', type: 'bool', default: 'false' },
    ],
    code: kt`bindings[id] = HandlerBinding(handler, availableToPackages)`,
  });
  f.fn('binding', {
    of: 'HandlerCatalog',
    doc: 'The handler for an id, if this build has it.',
    params: [{ name: 'id', type: 'string' }],
    returns: 'Option<HandlerBinding>',
    expression: true,
    code: kt`bindings[id]`,
  });

  f.decl(
    kt`
      private val MODULE_ID = Regex("^[a-z][a-z0-9]*(\\.[a-z][a-z0-9_]*)+$")
      private val SEMVER = Regex("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$")
    `,
    { doc: 'Accepted forms of module ids and versions.' },
  );

  f.fn('validateManifest', {
    doc: 'Every reason a manifest cannot be installed, empty when it can. Checks the format, that each capability is known and each tool\'s capability is one the module requests, that every handler exists and may be used by this kind of module, that tool schemas are ones the argument validator understands, and that the platform is new enough.',
    params: [
      { name: 'manifest', type: 'ModuleManifest' },
      { name: 'source', type: 'ModuleSource' },
      { name: 'handlers', type: 'HandlerCatalog' },
    ],
    returns: 'List<ManifestProblem>',
    code: kt`
      val problems = mutableListOf<ManifestProblem>()
      fun problem(field: String, message: String) = problems.add(ManifestProblem(field, message))

      if (manifest.schemaVersion != MANIFEST_SCHEMA_VERSION) {
          problem("schemaVersion", "schema version " + manifest.schemaVersion + " is not supported; this build reads " + MANIFEST_SCHEMA_VERSION)
      }
      if (!MODULE_ID.matches(manifest.id)) problem("id", "must be lower-case and dotted, like draken.notes")
      if (manifest.name.isBlank() || manifest.name.length > 60) problem("name", "must be 1 to 60 characters")
      if (!SEMVER.matches(manifest.version)) problem("version", "must be a semantic version, like 1.2.0")
      if (manifest.description.length > 500) problem("description", "must be at most 500 characters")
      if (manifest.publisher.isBlank()) problem("publisher", "must name who published the module")
      if (manifest.minPlatformVersion > MODULE_PLATFORM_VERSION) {
          problem("minPlatformVersion", "needs platform version " + manifest.minPlatformVersion + "; this build is " + MODULE_PLATFORM_VERSION)
      }

      val requested = manifest.capabilities.map { it.id }
      if (requested.size != requested.toSet().size) problem("capabilities", "lists a capability twice")
      for (capability in manifest.capabilities) {
          if (capabilityById(capability.id) == null) problem("capabilities", "\"" + capability.id + "\" is not a known capability")
          if (capability.reason.isBlank()) problem("capabilities", "\"" + capability.id + "\" needs a reason the user can read")
      }

      val toolIds = manifest.tools.map { it.id }
      if (toolIds.size != toolIds.toSet().size) problem("tools", "declares a tool twice")
      for (tool in manifest.tools) {
          val field = "tools." + tool.id
          if (!tool.id.startsWith(manifest.id + ".")) problem(field, "tool ids must start with the module id")
          if (wireName(tool.id).length > 64) problem(field, "the tool id is too long for model APIs")
          if (tool.capability !in requested) problem(field, "uses \"" + tool.capability + "\", which the module does not request")
          if (tool.description.isBlank()) problem(field, "needs a description the model can use")
          val binding = handlers.binding(tool.handler)
          if (binding == null) {
              problem(field, "no handler \"" + tool.handler + "\" in this build")
          } else if (source == ModuleSource.PACKAGE && !binding.availableToPackages) {
              problem(field, "handler \"" + tool.handler + "\" is not available to packages")
          }
          if (stringField(tool.inputSchema, "type") != "object") problem(field, "the input schema must describe an object")
          // An empty object exercises every keyword in the schema, so an
          // unsupported one shows up here rather than at the first call.
          validateArguments(tool.inputSchema, JsonObject(emptyMap()))
              .filter { it.contains("unsupported") }
              .forEach { problem(field, it) }
      }
      for (dependency in manifest.dependencies) {
          if (!SEMVER.matches(dependency.minVersion)) problem("dependencies." + dependency.id, "minVersion must be a semantic version")
          if (dependency.id == manifest.id) problem("dependencies", "a module cannot depend on itself")
      }
      return problems
    `,
  });

  f.fn('compareVersions', {
    doc: 'Compare two semantic versions numerically: negative, zero or positive.',
    params: [
      { name: 'a', type: 'string' },
      { name: 'b', type: 'string' },
    ],
    returns: 'i32',
    code: kt`
      val left = a.split('.').map { it.toIntOrNull() ?: 0 }
      val right = b.split('.').map { it.toIntOrNull() ?: 0 }
      for (i in 0 until maxOf(left.size, right.size)) {
          val difference = left.getOrElse(i) { 0 } - right.getOrElse(i) { 0 }
          if (difference != 0) return difference
      }
      return 0
    `,
  });
}

function manager(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/ModuleManager.kt`, { doc: 'module lifecycle' });

  f.iface(
    'ModuleStore',
    [
      { name: 'all', suspend: true, returns: 'List<InstalledModule>', doc: 'Every installed module.' },
      { name: 'find', suspend: true, params: [{ name: 'id', type: 'string' }], returns: 'Option<InstalledModule>', doc: 'One installed module.' },
      { name: 'save', suspend: true, params: [{ name: 'module', type: 'InstalledModule' }], doc: 'Insert or replace.' },
      { name: 'remove', suspend: true, params: [{ name: 'id', type: 'string' }], doc: 'Forget a module.' },
    ],
    { doc: 'Where installed modules are recorded.' },
  );

  f.enm(
    'ModuleChange',
    [
      { name: 'Done', payload: [{ name: 'module', type: 'InstalledModule' }] },
      { name: 'Rejected', payload: [{ name: 'problems', type: 'List<ManifestProblem>' }] },
    ],
    { doc: 'The result of installing, updating or removing a module.' },
  );

  f.cls('ModuleManager', {
    doc: 'Installs, updates, enables, disables and removes modules, and keeps the tool registry in step: a module\'s tools are registered exactly while it is installed and enabled.',
    implements: ['ModuleDirectory'],
    fields: [
      { name: 'store', type: 'ModuleStore', visibility: 'private' },
      { name: 'handlers', type: 'HandlerCatalog', visibility: 'private' },
      { name: 'registry', type: 'ToolRegistry', visibility: 'private' },
      { name: 'grants', type: 'GrantStore', visibility: 'private' },
      { name: 'audit', type: 'AuditLog', visibility: 'private' },
      { name: 'clock', type: '() -> i64', visibility: 'private' },
      { name: 'lock', type: 'Mutex', default: 'Mutex()', visibility: 'private' },
    ],
    ctor: [
      { name: 'store', type: 'ModuleStore' },
      { name: 'handlers', type: 'HandlerCatalog' },
      { name: 'registry', type: 'ToolRegistry' },
      { name: 'grants', type: 'GrantStore' },
      { name: 'audit', type: 'AuditLog' },
      { name: 'clock', type: '() -> i64', default: '{ System.currentTimeMillis() }' },
    ],
  });

  f.fn('installedModule', {
    of: 'ModuleManager',
    override: true,
    suspend: true,
    doc: 'The module, if installed.',
    params: [{ name: 'moduleId', type: 'string' }],
    returns: 'Option<InstalledModule>',
    expression: true,
    code: kt`store.find(moduleId)`,
  });

  f.fn('installed', {
    of: 'ModuleManager',
    suspend: true,
    doc: 'Every installed module, by name.',
    returns: 'List<InstalledModule>',
    expression: true,
    code: kt`store.all().sortedBy { it.manifest.name }`,
  });

  f.fn('restore', {
    of: 'ModuleManager',
    suspend: true,
    doc: 'At startup: register the tools of every enabled module. A stored module that no longer validates - this build dropped a handler it used - is turned off and reported, never run.',
    returns: 'List<string>',
    code: kt`
      val reports = mutableListOf<String>()
      lock.withLock {
          for (module in store.all()) {
              if (!module.enabled) continue
              val problems = validateManifest(module.manifest, module.source, handlers)
              if (problems.isEmpty()) {
                  registerTools(module.manifest)
              } else {
                  store.save(module.copy(enabled = false))
                  reports.add(module.manifest.name + " was turned off: " + problems.joinToString("; ") { it.message })
              }
          }
      }
      return reports
    `,
  });

  f.fn('install', {
    of: 'ModuleManager',
    suspend: true,
    doc: 'Install a module, or update one to a newer version. An update keeps the user\'s grants only for capabilities the new version still requests; nothing new is granted by installing.',
    params: [
      { name: 'manifest', type: 'ModuleManifest' },
      { name: 'source', type: 'ModuleSource' },
    ],
    returns: 'ModuleChange',
    code: kt`
      lock.withLock {
          val problems = validateManifest(manifest, source, handlers).toMutableList()
          for (dependency in manifest.dependencies) {
              val installed = store.find(dependency.id)
              if (installed == null) {
                  problems.add(ManifestProblem("dependencies." + dependency.id, "needs " + dependency.id + ", which is not installed"))
              } else if (compareVersions(installed.manifest.version, dependency.minVersion) < 0) {
                  problems.add(ManifestProblem("dependencies." + dependency.id, "needs version " + dependency.minVersion + " or later"))
              }
          }
          val existing = store.find(manifest.id)
          if (existing != null) {
              if (existing.source != source) problems.add(ManifestProblem("id", "a module with this id is already installed from elsewhere"))
              else if (compareVersions(manifest.version, existing.manifest.version) <= 0) problems.add(ManifestProblem("version", "is not newer than the installed " + existing.manifest.version))
          }
          if (problems.isNotEmpty()) {
              audit.record(AuditEvent(clock(), AuditCategory.MODULE_LIFECYCLE, manifest.id, "install_rejected"))
              return ModuleChange.Rejected(problems)
          }
          if (existing != null) {
              registry.unregisterModule(manifest.id)
              val kept = manifest.capabilities.map { it.id }.toSet()
              for (old in existing.manifest.capabilities) if (old.id !in kept) grants.setGranted(manifest.id, old.id, false)
          }
          val module = InstalledModule(manifest, existing?.enabled ?: true, source, existing?.installedAt ?: clock())
          store.save(module)
          if (module.enabled) registerTools(manifest)
          audit.record(AuditEvent(clock(), AuditCategory.MODULE_LIFECYCLE, manifest.id, if (existing == null) "installed" else "updated", manifest.version))
          return ModuleChange.Done(module)
      }
    `,
  });

  f.fn('setEnabled', {
    of: 'ModuleManager',
    suspend: true,
    doc: 'Turn a module on or off. Off, its tools are gone from the registry, so no model is offered them and no call can reach them.',
    params: [
      { name: 'id', type: 'string' },
      { name: 'enabled', type: 'bool' },
    ],
    returns: 'bool',
    code: kt`
      lock.withLock {
          val module = store.find(id) ?: return false
          if (module.enabled == enabled) return true
          if (enabled) {
              val problems = validateManifest(module.manifest, module.source, handlers)
              if (problems.isNotEmpty()) return false
              registerTools(module.manifest)
          } else {
              registry.unregisterModule(id)
          }
          store.save(module.copy(enabled = enabled))
          audit.record(AuditEvent(clock(), AuditCategory.MODULE_LIFECYCLE, id, if (enabled) "enabled" else "disabled"))
          return true
      }
    `,
  });

  f.fn('uninstall', {
    of: 'ModuleManager',
    suspend: true,
    doc: 'Remove a package and forget every grant it held. A built-in module is part of the app and can only be turned off; a module others depend on cannot be removed until they are.',
    params: [{ name: 'id', type: 'string' }],
    returns: 'ModuleChange',
    code: kt`
      lock.withLock {
          val module = store.find(id) ?: return ModuleChange.Rejected(listOf(ManifestProblem("id", "is not installed")))
          if (module.source == ModuleSource.BUILT_IN) {
              return ModuleChange.Rejected(listOf(ManifestProblem("id", module.manifest.name + " is built in; turn it off instead")))
          }
          val dependents = store.all().filter { other -> other.manifest.dependencies.any { it.id == id } }
          if (dependents.isNotEmpty()) {
              return ModuleChange.Rejected(listOf(ManifestProblem("id", "needed by " + dependents.joinToString(", ") { it.manifest.name })))
          }
          registry.unregisterModule(id)
          grants.revokeAll(id)
          store.remove(id)
          audit.record(AuditEvent(clock(), AuditCategory.MODULE_LIFECYCLE, id, "removed"))
          return ModuleChange.Done(module)
      }
    `,
  });

  f.fn('registerTools', {
    of: 'ModuleManager',
    visibility: 'private',
    doc: 'Register a validated module\'s tools with their trusted handlers.',
    params: [{ name: 'manifest', type: 'ModuleManifest' }],
    code: kt`
      for (tool in manifest.tools) {
          val binding = handlers.binding(tool.handler) ?: continue
          registry.register(
              ToolSpec(tool.id, manifest.id, tool.title, tool.description, tool.inputSchema, tool.capability, tool.risk, tool.requiresConfirmation || tool.risk == RiskLevel.DESTRUCTIVE),
              binding.handler,
          )
      }
    `,
  });
}
