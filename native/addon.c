// dsh-cua — N-API binding
//
// Bridges JavaScript to the Swift accessibility core. Every operation runs on a
// libuv worker thread: AX walks, screenshot capture and the deliberate settle
// delays are all blocking, and running them on the JS thread would stall the
// REPL (and therefore the MCP server) for the whole duration.

#include <node_api.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

// ---- Swift C ABI -----------------------------------------------------------

extern int32_t dsh_cua_is_trusted(void);
extern char *dsh_cua_get_app_state(const char *json);
extern char *dsh_cua_list_apps(const char *json);
extern char *dsh_cua_action(const char *name, const char *json);
extern char *dsh_cua_preflight(void);
extern void dsh_cua_free(char *ptr);

// ---- helpers ---------------------------------------------------------------

#define NAPI_OK(env, call)                                                      \
  do {                                                                          \
    if ((call) != napi_ok) {                                                    \
      napi_throw_error((env), NULL, "N-API call failed: " #call);                \
      return NULL;                                                              \
    }                                                                           \
  } while (0)

typedef enum { OP_GET_APP_STATE, OP_LIST_APPS, OP_ACTION, OP_PREFLIGHT } op_kind;

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  op_kind kind;
  char *arg;      // JSON payload
  char *op_name;  // action name (OP_ACTION only)
  char *result;   // JSON result produced by the core
} cua_task;

static void task_execute(napi_env env, void *data) {
  cua_task *t = (cua_task *)data;
  switch (t->kind) {
    case OP_GET_APP_STATE: t->result = dsh_cua_get_app_state(t->arg ? t->arg : "{}"); break;
    case OP_LIST_APPS:     t->result = dsh_cua_list_apps(t->arg ? t->arg : "{}"); break;
    case OP_ACTION:        t->result = dsh_cua_action(t->op_name ? t->op_name : "", t->arg ? t->arg : "{}"); break;
    case OP_PREFLIGHT:     t->result = dsh_cua_preflight(); break;
  }
}

// Parse the JSON produced by the core and hand it back as a real JS object, so
// callers read `state.text` rather than parsing a string themselves.
static napi_value to_js(napi_env env, const char *json) {
  napi_value parsed;
  napi_value global, json_obj, parse_fn, arg, undef;
  if (json == NULL) {
    napi_get_undefined(env, &parsed);
    return parsed;
  }
  if (napi_get_global(env, &global) != napi_ok) return NULL;
  if (napi_get_named_property(env, global, "JSON", &json_obj) != napi_ok) return NULL;
  if (napi_get_named_property(env, json_obj, "parse", &parse_fn) != napi_ok) return NULL;
  if (napi_create_string_utf8(env, json, NAPI_AUTO_LENGTH, &arg) != napi_ok) return NULL;
  napi_get_undefined(env, &undef);
  if (napi_call_function(env, json_obj, parse_fn, 1, &arg, &parsed) != napi_ok) return NULL;
  return parsed;
}

static void task_complete(napi_env env, napi_status status, void *data) {
  cua_task *t = (cua_task *)data;
  if (status == napi_ok && t->result != NULL) {
    napi_value value = to_js(env, t->result);
    napi_resolve_deferred(env, t->deferred, value);
  } else {
    napi_value msg, err;
    napi_create_string_utf8(env, "dsh-cua native operation failed", NAPI_AUTO_LENGTH, &msg);
    napi_create_error(env, NULL, msg, &err);
    napi_reject_deferred(env, t->deferred, err);
  }
  napi_delete_async_work(env, t->work);
  if (t->arg) free(t->arg);
  if (t->op_name) free(t->op_name);
  if (t->result) dsh_cua_free(t->result);
  free(t);
}

// Queue one operation and return its promise.
static napi_value queue(napi_env env, op_kind kind, const char *op_name, const char *arg_json) {
  cua_task *t = (cua_task *)calloc(1, sizeof(cua_task));
  t->kind = kind;
  t->arg = arg_json ? strdup(arg_json) : NULL;
  t->op_name = op_name ? strdup(op_name) : NULL;

  napi_value promise;
  NAPI_OK(env, napi_create_promise(env, &t->deferred, &promise));

  napi_value resource_name;
  NAPI_OK(env, napi_create_string_utf8(env, "dsh-cua", NAPI_AUTO_LENGTH, &resource_name));
  NAPI_OK(env, napi_create_async_work(env, NULL, resource_name, task_execute, task_complete, t, &t->work));
  NAPI_OK(env, napi_queue_async_work(env, t->work));
  return promise;
}

// Pull an optional string argument out of argv[i].
// Returns 0 on success (including "absent", which yields NULL), -1 on failure.
static int arg_string(napi_env env, napi_value *argv, size_t argc, size_t i, char **out) {
  *out = NULL;
  if (i >= argc) return 0;
  napi_valuetype type;
  if (napi_typeof(env, argv[i], &type) != napi_ok) return -1;
  if (type == napi_undefined || type == napi_null) return 0;
  if (type != napi_string) return -1;
  size_t len = 0;
  if (napi_get_value_string_utf8(env, argv[i], NULL, 0, &len) != napi_ok) return -1;
  char *buf = (char *)malloc(len + 1);
  if (buf == NULL) return -1;
  if (napi_get_value_string_utf8(env, argv[i], buf, len + 1, &len) != napi_ok) {
    free(buf);
    return -1;
  }
  *out = buf;
  return 0;
}

// Stringify argv[i] via JSON.stringify so callers can pass a real object.
// Returns 0 on success, -1 on failure. Absent/null yields "{}".
static int arg_json(napi_env env, napi_value *argv, size_t argc, size_t i, char **out) {
  *out = NULL;
  if (i >= argc) {
    *out = strdup("{}");
    return *out ? 0 : -1;
  }
  napi_valuetype type;
  if (napi_typeof(env, argv[i], &type) != napi_ok) return -1;
  if (type == napi_undefined || type == napi_null) {
    *out = strdup("{}");
    return *out ? 0 : -1;
  }
  // A string is treated as pre-serialized JSON, which keeps the binding usable
  // from plain C-style callers and tests.
  if (type == napi_string) {
    return arg_string(env, argv, argc, i, out);
  }

  napi_value global, json_obj, stringify_fn, result;
  if (napi_get_global(env, &global) != napi_ok) return -1;
  if (napi_get_named_property(env, global, "JSON", &json_obj) != napi_ok) return -1;
  if (napi_get_named_property(env, json_obj, "stringify", &stringify_fn) != napi_ok) return -1;
  if (napi_call_function(env, json_obj, stringify_fn, 1, &argv[i], &result) != napi_ok) return -1;

  size_t len = 0;
  if (napi_get_value_string_utf8(env, result, NULL, 0, &len) != napi_ok) return -1;
  char *buf = (char *)malloc(len + 1);
  if (buf == NULL) return -1;
  if (napi_get_value_string_utf8(env, result, buf, len + 1, &len) != napi_ok) {
    free(buf);
    return -1;
  }
  *out = buf;
  return 0;
}

// ---- exported functions ----------------------------------------------------

static napi_value JsIsTrusted(napi_env env, napi_callback_info info) {
  napi_value out;
  NAPI_OK(env, napi_get_boolean(env, dsh_cua_is_trusted() == 1, &out));
  return out;
}

static napi_value JsGetAppState(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_OK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  char *arg = NULL;
  if (arg_json(env, argv, argc, 0, &arg) != 0) {
    napi_throw_type_error(env, NULL, "getAppState(params) requires a plain object");
    return NULL;
  }
  napi_value p = queue(env, OP_GET_APP_STATE, NULL, arg);
  if (arg) free(arg);
  return p;
}

static napi_value JsListApps(napi_env env, napi_callback_info info) {
  return queue(env, OP_LIST_APPS, NULL, NULL);
}

static napi_value JsAction(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_OK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  char *name = NULL;
  char *arg = NULL;
  if (arg_string(env, argv, argc, 0, &name) != 0 || name == NULL) {
    napi_throw_type_error(env, NULL, "action(name, params) requires a name string");
    if (name) free(name);
    return NULL;
  }
  if (arg_json(env, argv, argc, 1, &arg) != 0) {
    napi_throw_type_error(env, NULL, "action(name, params) requires params to be an object");
    free(name);
    return NULL;
  }
  napi_value p = queue(env, OP_ACTION, name, arg);
  free(name);
  if (arg) free(arg);
  return p;
}

static napi_value JsPreflight(napi_env env, napi_callback_info info) {
  return queue(env, OP_PREFLIGHT, NULL, NULL);
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    { "isTrusted",   NULL, JsIsTrusted,   NULL, NULL, NULL, napi_default, NULL },
    { "getAppState", NULL, JsGetAppState, NULL, NULL, NULL, napi_default, NULL },
    { "listApps",    NULL, JsListApps,    NULL, NULL, NULL, napi_default, NULL },
    { "action",      NULL, JsAction,      NULL, NULL, NULL, napi_default, NULL },
    { "preflight",   NULL, JsPreflight,   NULL, NULL, NULL, napi_default, NULL },
  };
  NAPI_OK(env, napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props));
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)