#include <node_api.h>
#include <stdio.h>
#include <stdlib.h>

static napi_value Init(napi_env env, napi_value exports) {
  const char *sentinel = getenv("PISCES_EXTENSION_NATIVE_SENTINEL");
  if (sentinel != NULL) {
    FILE *file = fopen(sentinel, "w");
    if (file != NULL) {
      fputs("1", file);
      fclose(file);
    }
  }

  napi_value value;
  napi_create_string_utf8(env, "native", NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, exports, "sentinel", value);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
