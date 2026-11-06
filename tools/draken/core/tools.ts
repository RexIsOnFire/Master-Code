/**
 * Capabilities, the permission broker, audit, and the tool pipeline.
 *
 * Every tool call a model proposes goes through one sequence, in this order:
 *
 *   1. find the tool by its wire name           unknown -> UNKNOWN_TOOL
 *   2. parse and validate the arguments          invalid -> INVALID_ARGUMENTS
 *   3. authorize through the broker, now          denied  -> PERMISSION_DENIED
 *   4. ask the user, if the tool requires it      no      -> USER_DECLINED
 *   5. run the trusted handler, with a time limit  throws  -> EXECUTION_FAILED
 *   6. return the actual result, or the failure
 *   7. record an audit event - never the arguments or the result
 *
 * The model is untrusted input at every step. It cannot grant anything: there
 * is no tool that changes a grant, and grants are only written by the
 * interface acting on the user's decision.
 */

import type { Ctx } from '../kit.ts';
import { KtFile, kt } from '../kit.ts';

const ROOT = 'core/src/main/kotlin/com/draken/core';

export function buildTools(ctx: Ctx): void {
  capabilities(ctx);
  broker(ctx);
  audit(ctx);
  schema(ctx);
  registry(ctx);
  executor(ctx);
}

function capabilities(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/permissions/Capabilities.kt`, { doc: 'what modules may ask to do' });

  f.enm('RiskLevel', ['READ', 'WRITE', 'DESTRUCTIVE', 'EXTERNAL'], {
    doc: 'How much harm an action can do: reading local data, writing it, removing it, or reaching outside the device.',
  });

  f.record(
    'CapabilityDefinition',
    [
      { name: 'id', type: 'string' },
      { name: 'title', type: 'string' },
      { name: 'description', type: 'string', doc: 'What granting it allows, in the words shown to the user.' },
      { name: 'risk', type: 'RiskLevel' },
      {
        name: 'androidPermissions',
        type: 'List<string>',
        default: 'emptyList()',
        doc: 'Runtime permissions the platform must also hold. A grant without them still fails at execution.',
      },
    ],
    { doc: 'One capability a module can request.' },
  );

  f.fn('knownCapabilities', {
    doc: 'Every capability the platform recognises. A manifest asking for anything else is rejected.',
    returns: 'List<CapabilityDefinition>',
    expression: true,
    code: kt`
      listOf(
          CapabilityDefinition("notes.read", "Read notes", "Read and search the notes stored in Draken.", RiskLevel.READ),
          CapabilityDefinition("notes.write", "Change notes", "Create, edit and delete notes stored in Draken.", RiskLevel.WRITE),
          CapabilityDefinition(
              "calendar.read",
              "Read calendar",
              "Read events from the calendars on this device.",
              RiskLevel.READ,
              listOf("android.permission.READ_CALENDAR"),
          ),
          CapabilityDefinition(
              "calendar.write",
              "Change calendar",
              "Add and change events in the calendars on this device.",
              RiskLevel.WRITE,
              listOf("android.permission.READ_CALENDAR", "android.permission.WRITE_CALENDAR"),
          ),
      )
    `,
  });

  f.fn('capabilityById', {
    doc: 'A known capability, or null.',
    params: [{ name: 'id', type: 'string' }],
    returns: 'Option<CapabilityDefinition>',
    expression: true,
    code: kt`knownCapabilities().firstOrNull { it.id == id }`,
  });
}

function broker(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/permissions/PermissionBroker.kt`, { doc: 'authorization at execution time' });

  f.iface(
    'GrantStore',
    [
      {
        name: 'isGranted',
        suspend: true,
        params: [
          { name: 'moduleId', type: 'string' },
          { name: 'capabilityId', type: 'string' },
        ],
        returns: 'bool',
        doc: 'Whether the user granted this capability to this module.',
      },
      {
        name: 'setGranted',
        suspend: true,
        params: [
          { name: 'moduleId', type: 'string' },
          { name: 'capabilityId', type: 'string' },
          { name: 'granted', type: 'bool' },
        ],
        doc: 'Record the user\'s decision. Only the interface calls this, acting on the user.',
      },
      {
        name: 'revokeAll',
        suspend: true,
        params: [{ name: 'moduleId', type: 'string' }],
        doc: 'Forget every grant a module held, as when it is removed.',
      },
    ],
    { doc: 'Where the user\'s capability grants are kept.' },
  );

  f.iface(
    'PlatformPermissions',
    [
      {
        name: 'isGranted',
        params: [{ name: 'permission', type: 'string' }],
        returns: 'bool',
        doc: 'Whether the operating system currently grants a runtime permission. Asked every time: the user can revoke it in system settings at any moment.',
      },
    ],
    { doc: 'The operating system\'s runtime permissions.' },
  );

  f.iface(
    'ModuleDirectory',
    [
      {
        name: 'installedModule',
        suspend: true,
        params: [{ name: 'moduleId', type: 'string' }],
        returns: 'Option<InstalledModule>',
        doc: 'The module, if installed.',
      },
    ],
    { doc: 'What the broker needs to know about installed modules.' },
  );

  f.enm('DenialReason', ['UNKNOWN_MODULE', 'MODULE_DISABLED', 'NOT_DECLARED', 'UNKNOWN_CAPABILITY', 'NOT_GRANTED', 'PLATFORM_PERMISSION_MISSING'], {
    doc: 'Why an action was not authorized.',
  });

  f.enm(
    'Authorization',
    [
      'Allowed',
      {
        name: 'Denied',
        payload: [
          { name: 'reason', type: 'DenialReason' },
          { name: 'detail', type: 'string' },
        ],
      },
    ],
    { doc: 'The broker\'s answer.' },
  );

  f.cls('PermissionBroker', {
    doc: 'The single place sensitive operations are authorized. Every check is made at execution time, against current state: a module\'s manifest declaring a capability is a request, never an authorization.',
    fields: [
      { name: 'modules', type: 'ModuleDirectory', visibility: 'private' },
      { name: 'grants', type: 'GrantStore', visibility: 'private' },
      { name: 'platform', type: 'PlatformPermissions', visibility: 'private' },
    ],
    ctor: [
      { name: 'modules', type: 'ModuleDirectory' },
      { name: 'grants', type: 'GrantStore' },
      { name: 'platform', type: 'PlatformPermissions' },
    ],
  });
  f.fn('authorize', {
    of: 'PermissionBroker',
    suspend: true,
    doc: 'Whether a module may use a capability right now: installed, enabled, declared, known, granted by the user, and backed by every runtime permission it needs.',
    params: [
      { name: 'moduleId', type: 'string' },
      { name: 'capabilityId', type: 'string' },
    ],
    returns: 'Authorization',
    code: kt`
      val module = modules.installedModule(moduleId)
          ?: return Authorization.Denied(DenialReason.UNKNOWN_MODULE, "The module \"" + moduleId + "\" is not installed.")
      if (!module.enabled) return Authorization.Denied(DenialReason.MODULE_DISABLED, module.manifest.name + " is turned off.")
      if (module.manifest.capabilities.none { it.id == capabilityId }) {
          return Authorization.Denied(DenialReason.NOT_DECLARED, module.manifest.name + " did not declare \"" + capabilityId + "\".")
      }
      val capability = capabilityById(capabilityId)
          ?: return Authorization.Denied(DenialReason.UNKNOWN_CAPABILITY, "\"" + capabilityId + "\" is not a capability this version knows.")
      if (!grants.isGranted(moduleId, capabilityId)) {
          return Authorization.Denied(
              DenialReason.NOT_GRANTED,
              module.manifest.name + " has not been allowed to " + capability.title.lowercase() + ". The user can allow it in Modules.",
          )
      }
      val missing = capability.androidPermissions.filterNot { platform.isGranted(it) }
      if (missing.isNotEmpty()) {
          return Authorization.Denied(
              DenialReason.PLATFORM_PERMISSION_MISSING,
              "Android has not granted " + missing.joinToString(", ") { it.substringAfterLast('.') } + ".",
          )
      }
      return Authorization.Allowed
    `,
  });
}

function audit(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/permissions/Audit.kt`, { doc: 'the security audit trail' });

  f.enm('AuditCategory', ['TOOL_CALL', 'PERMISSION_CHANGE', 'MODULE_LIFECYCLE', 'CLOUD_REQUEST', 'CREDENTIAL_CHANGE'], {
    doc: 'What kind of event was recorded.',
  });

  f.record(
    'AuditEvent',
    [
      { name: 'at', type: 'i64' },
      { name: 'category', type: 'AuditCategory' },
      { name: 'subject', type: 'string', doc: 'What it concerns: a tool id, a module id, a provider id.' },
      { name: 'outcome', type: 'string', doc: 'A stable code: ok, denied:not_granted, failed:execution, ...' },
      {
        name: 'detail',
        type: 'string',
        default: '""',
        doc: 'Non-sensitive context only. Never message text, tool arguments, results or keys.',
      },
    ],
    { doc: 'One security-relevant event. The schema has no field that could hold content, which is the point.' },
  );

  f.iface(
    'AuditLog',
    [{ name: 'record', suspend: true, params: [{ name: 'event', type: 'AuditEvent' }], doc: 'Append an event.' }],
    { doc: 'Where audit events go.' },
  );
}

function schema(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/tools/ArgumentValidation.kt`, { doc: 'validating model-proposed arguments' });

  f.fn('validateArguments', {
    doc: 'Check arguments against a tool\'s JSON Schema, returning every problem found (empty when valid). Supports the subset tool schemas here use - object, string, integer, number, boolean and array types; properties, required, additionalProperties false; enum; minLength/maxLength; minimum/maximum; items; maxItems. A keyword it does not support makes the schema invalid, rather than being silently skipped.',
    params: [
      { name: 'schema', type: 'JsonObject' },
      { name: 'value', type: 'JsonElement' },
    ],
    returns: 'List<string>',
    code: kt`
      val problems = mutableListOf<String>()
      checkValue(schema, value, "arguments", problems)
      return problems
    `,
  });

  f.decl(
    kt`
      private val SUPPORTED_KEYWORDS = setOf(
          "type", "description", "title", "properties", "required", "additionalProperties", "enum",
          "minLength", "maxLength", "minimum", "maximum", "items", "maxItems", "default",
      )
    `,
    { doc: 'Schema keywords the validator understands.' },
  );

  f.fn('checkValue', {
    visibility: 'private',
    doc: 'Validate one value against one schema node, appending problems with their path.',
    params: [
      { name: 'schema', type: 'JsonObject' },
      { name: 'value', type: 'JsonElement' },
      { name: 'path', type: 'string' },
      { name: 'problems', type: 'MutableList<string>' },
    ],
    code: kt`
      schema.keys.firstOrNull { it !in SUPPORTED_KEYWORDS }?.let {
          problems.add(path + ": schema uses unsupported keyword \"" + it + "\"")
          return
      }
      val type = stringField(schema, "type")
      val primitive = value as? JsonPrimitive
      when (type) {
          "object" -> {
              val obj = value as? JsonObject ?: run { problems.add(path + " must be an object"); return }
              val properties = objectField(schema, "properties") ?: JsonObject(emptyMap())
              for (name in arrayField(schema, "required").mapNotNull { (it as? JsonPrimitive)?.contentOrNull }) {
                  if (name !in obj) problems.add(path + "." + name + " is required")
              }
              val closed = (schema["additionalProperties"] as? JsonPrimitive)?.booleanOrNull == false
              for ((name, member) in obj) {
                  val memberSchema = properties[name] as? JsonObject
                  if (memberSchema == null) {
                      if (closed) problems.add(path + "." + name + " is not an accepted argument")
                  } else {
                      checkValue(memberSchema, member, path + "." + name, problems)
                  }
              }
          }
          "string" -> {
              if (primitive == null || !primitive.isString) {
                  problems.add(path + " must be text")
                  return
              }
              val length = primitive.content.length.toLong()
              longField(schema, "minLength")?.let { if (length < it) problems.add(path + " must be at least " + it + " characters") }
              longField(schema, "maxLength")?.let { if (length > it) problems.add(path + " must be at most " + it + " characters") }
          }
          "integer", "number" -> {
              val number = if (primitive == null || primitive.isString) null else primitive.doubleOrNull
              if (number == null) {
                  problems.add(path + " must be a number")
                  return
              }
              if (type == "integer" && number != Math.floor(number)) {
                  problems.add(path + " must be a whole number")
                  return
              }
              (schema["minimum"] as? JsonPrimitive)?.doubleOrNull?.let { if (number < it) problems.add(path + " must be at least " + it) }
              (schema["maximum"] as? JsonPrimitive)?.doubleOrNull?.let { if (number > it) problems.add(path + " must be at most " + it) }
          }
          "boolean" -> if (primitive?.booleanOrNull == null || primitive.isString) problems.add(path + " must be true or false")
          "array" -> {
              val array = value as? JsonArray ?: run { problems.add(path + " must be a list"); return }
              longField(schema, "maxItems")?.let { if (array.size > it) problems.add(path + " must have at most " + it + " items") }
              objectField(schema, "items")?.let { items -> array.forEachIndexed { i, item -> checkValue(items, item, path + "[" + i + "]", problems) } }
          }
          else -> problems.add(path + ": schema has unsupported type \"" + type + "\"")
      }
      val allowed = schema["enum"] as? JsonArray
      if (allowed != null && value !in allowed) problems.add(path + " must be one of " + allowed.joinToString(", "))
    `,
  });
}

function registry(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/tools/ToolRegistry.kt`, { doc: 'the typed tool registry' });

  f.record(
    'ToolSpec',
    [
      { name: 'id', type: 'string', doc: 'Namespaced by its module: draken.notes.create.' },
      { name: 'moduleId', type: 'string' },
      { name: 'title', type: 'string' },
      { name: 'description', type: 'string', doc: 'What the model is told the tool does.' },
      { name: 'inputSchema', type: 'JsonObject' },
      { name: 'capability', type: 'string', doc: 'The capability the broker must authorize before it runs.' },
      { name: 'risk', type: 'RiskLevel' },
      { name: 'requiresConfirmation', type: 'bool', doc: 'Ask the user before every run.' },
    ],
    { doc: 'Everything known about a tool before it runs.' },
  );

  f.fn('wireName', {
    doc: 'The name a tool goes by on the wire. Vendors accept letters, digits, underscores and hyphens, so dots become underscores.',
    params: [{ name: 'toolId', type: 'string' }],
    returns: 'string',
    expression: true,
    code: kt`toolId.replace('.', '_')`,
  });

  f.enm(
    'ToolOutcome',
    [
      {
        name: 'Success',
        payload: [
          { name: 'content', type: 'JsonElement' },
          { name: 'summary', type: 'string' },
        ],
      },
      {
        name: 'Failure',
        payload: [
          { name: 'code', type: 'ToolFailureCode' },
          { name: 'message', type: 'string' },
        ],
      },
    ],
    { doc: 'What a tool run produced: content for the model and a one-line summary for the conversation, or a failure. Nothing reports success except a handler that succeeded.' },
  );

  f.enm(
    'ToolFailureCode',
    ['UNKNOWN_TOOL', 'INVALID_ARGUMENTS', 'PERMISSION_DENIED', 'USER_DECLINED', 'EXECUTION_FAILED', 'TIMED_OUT', 'NOT_FOUND'],
    { doc: 'Why a tool run failed, in a form the model can act on.' },
  );

  f.iface(
    'ToolHandler',
    [
      {
        name: 'execute',
        suspend: true,
        params: [{ name: 'arguments', type: 'JsonObject' }],
        returns: 'ToolOutcome',
        doc: 'Run with arguments that have already been validated and authorized.',
      },
    ],
    { doc: 'A trusted implementation of a tool. Only built-in code implements this.' },
  );

  f.cls('ToolRegistry', {
    doc: 'The tools currently available, by wire name. Module enablement adds and removes them; nothing else does.',
    fields: [
      { name: 'tools', type: 'MutableMap<string, Pair<ToolSpec, ToolHandler>>', default: 'java.util.concurrent.ConcurrentHashMap()', visibility: 'private' },
    ],
  });
  f.fn('register', {
    of: 'ToolRegistry',
    doc: 'Make a tool available. Two tools may never share a wire name.',
    params: [
      { name: 'spec', type: 'ToolSpec' },
      { name: 'handler', type: 'ToolHandler' },
    ],
    code: kt`
      val name = wireName(spec.id)
      val existing = tools[name]
      require(existing == null || existing.first.id == spec.id) { "wire name " + name + " is already used by " + existing?.first?.id }
      tools[name] = spec to handler
    `,
  });
  f.fn('unregisterModule', {
    of: 'ToolRegistry',
    doc: 'Remove every tool a module provided.',
    params: [{ name: 'moduleId', type: 'string' }],
    code: kt`tools.values.removeIf { it.first.moduleId == moduleId }`,
  });
  f.fn('lookup', {
    of: 'ToolRegistry',
    doc: 'A tool by the wire name a model used.',
    params: [{ name: 'name', type: 'string' }],
    returns: 'Option<Pair<ToolSpec, ToolHandler>>',
    expression: true,
    code: kt`tools[name]`,
  });
  f.fn('specs', {
    of: 'ToolRegistry',
    doc: 'Every available tool, in a stable order.',
    returns: 'List<ToolSpec>',
    expression: true,
    code: kt`tools.values.map { it.first }.sortedBy { it.id }`,
  });
  f.fn('definitions', {
    of: 'ToolRegistry',
    doc: 'Tools as offered to a model, sorted so the set - and so the prompt prefix - is stable.',
    returns: 'List<ToolDefinition>',
    expression: true,
    code: kt`specs().map { ToolDefinition(wireName(it.id), it.description, it.inputSchema) }`,
  });
}

function executor(ctx: Ctx): void {
  const f = new KtFile(ctx, `${ROOT}/tools/ToolExecutor.kt`, { doc: 'the tool execution pipeline' });
  f.use('kotlinx.serialization.json.put');

  f.record(
    'ConfirmationRequest',
    [
      { name: 'tool', type: 'ToolSpec' },
      { name: 'arguments', type: 'JsonObject', doc: 'Shown to the user so they approve exactly what will run.' },
    ],
    { doc: 'A consequential action awaiting the user.' },
  );

  f.iface(
    'ConfirmationGate',
    [
      {
        name: 'confirm',
        suspend: true,
        params: [{ name: 'request', type: 'ConfirmationRequest' }],
        returns: 'bool',
        doc: 'Ask the user, suspending until they answer. Cancelling the turn cancels the question.',
      },
    ],
    { doc: 'How the pipeline asks the user. The interface implements it with a dialog.' },
  );

  f.cls('ToolExecutor', {
    doc: 'Runs model-proposed tool calls through validation, authorization, confirmation, a bounded execution and audit - in that order, every time.',
    fields: [
      { name: 'registry', type: 'ToolRegistry', visibility: 'private' },
      { name: 'broker', type: 'PermissionBroker', visibility: 'private' },
      { name: 'confirmations', type: 'ConfirmationGate', visibility: 'private' },
      { name: 'audit', type: 'AuditLog', visibility: 'private' },
      { name: 'clock', type: '() -> i64', visibility: 'private' },
      { name: 'timeoutMillis', type: 'i64', visibility: 'private' },
    ],
    ctor: [
      { name: 'registry', type: 'ToolRegistry' },
      { name: 'broker', type: 'PermissionBroker' },
      { name: 'confirmations', type: 'ConfirmationGate' },
      { name: 'audit', type: 'AuditLog' },
      { name: 'clock', type: '() -> i64', default: '{ System.currentTimeMillis() }' },
      { name: 'timeoutMillis', type: 'i64', default: '20_000L' },
    ],
  });
  f.fn('execute', {
    of: 'ToolExecutor',
    suspend: true,
    doc: 'Run one call and say exactly what happened. Never throws for a tool failure - the failure is the result - but cancellation propagates.',
    params: [{ name: 'call', type: 'ToolCall' }],
    returns: 'ToolOutcome',
    code: kt`
      val entry = registry.lookup(call.toolName)
      if (entry == null) {
          record(call.toolName, "", "failed:unknown_tool")
          return ToolOutcome.Failure(ToolFailureCode.UNKNOWN_TOOL, "There is no tool named \"" + call.toolName + "\".")
      }
      val (spec, handler) = entry
      val arguments = parseJsonObject(call.argumentsJson)
      if (arguments == null) {
          record(spec.id, spec.moduleId, "failed:invalid_arguments")
          return ToolOutcome.Failure(ToolFailureCode.INVALID_ARGUMENTS, "The arguments were not a JSON object.")
      }
      val problems = validateArguments(spec.inputSchema, arguments)
      if (problems.isNotEmpty()) {
          record(spec.id, spec.moduleId, "failed:invalid_arguments")
          return ToolOutcome.Failure(ToolFailureCode.INVALID_ARGUMENTS, problems.joinToString("; "))
      }
      val authorization = broker.authorize(spec.moduleId, spec.capability)
      if (authorization is Authorization.Denied) {
          record(spec.id, spec.moduleId, "denied:" + authorization.reason.name.lowercase())
          return ToolOutcome.Failure(ToolFailureCode.PERMISSION_DENIED, authorization.detail)
      }
      if (spec.requiresConfirmation && !confirmations.confirm(ConfirmationRequest(spec, arguments))) {
          record(spec.id, spec.moduleId, "declined")
          return ToolOutcome.Failure(ToolFailureCode.USER_DECLINED, "The user declined this action.")
      }
      val outcome = try {
          withTimeout(timeoutMillis) { handler.execute(arguments) }
      } catch (timeout: TimeoutCancellationException) {
          ToolOutcome.Failure(ToolFailureCode.TIMED_OUT, spec.title + " did not finish in time.")
      } catch (cancelled: CancellationException) {
          throw cancelled
      } catch (failure: Exception) {
          // The message, not the stack: the model and the audit trail need what
          // went wrong, not the internals.
          ToolOutcome.Failure(ToolFailureCode.EXECUTION_FAILED, spec.title + " failed: " + (failure.message ?: failure.javaClass.simpleName))
      }
      record(spec.id, spec.moduleId, if (outcome is ToolOutcome.Success) "ok" else "failed:" + (outcome as ToolOutcome.Failure).code.name.lowercase())
      return outcome
    `,
  });
  f.fn('record', {
    of: 'ToolExecutor',
    visibility: 'private',
    suspend: true,
    doc: 'Audit one call: which tool, which module, what happened. Nothing the user or the model wrote.',
    params: [
      { name: 'toolId', type: 'string' },
      { name: 'moduleId', type: 'string' },
      { name: 'outcome', type: 'string' },
    ],
    code: kt`audit.record(AuditEvent(clock(), AuditCategory.TOOL_CALL, toolId, outcome, moduleId))`,
  });

  f.fn('toolResultRecord', {
    doc: 'An outcome as it is stored and sent back to the model: a JSON envelope that says plainly whether it worked.',
    params: [
      { name: 'call', type: 'ToolCall' },
      { name: 'outcome', type: 'ToolOutcome' },
    ],
    returns: 'ToolResultRecord',
    code: kt`
      val content = when (outcome) {
          is ToolOutcome.Success -> buildJsonObject {
              put("ok", true)
              put("result", outcome.content)
          }
          is ToolOutcome.Failure -> buildJsonObject {
              put("ok", false)
              put("error", outcome.code.name)
              put("message", outcome.message)
          }
      }
      return ToolResultRecord(call.id, call.toolName, outcome is ToolOutcome.Failure, content.toString())
    `,
  });
}
