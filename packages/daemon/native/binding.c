#include <errno.h>
#include <node_api.h>
#include <string.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <unistd.h>

#ifndef __linux__
#error "the Pisces peer credential binding supports Linux only"
#endif

static napi_value throw_errno(napi_env env, const char *syscall) {
  const int saved = errno;
  napi_value message = NULL;
  napi_create_string_utf8(env, syscall, NAPI_AUTO_LENGTH, &message);
  napi_value error = NULL;
  napi_create_error(env, NULL, message, &error);
  napi_value code = NULL;
  napi_create_int32(env, saved, &code);
  napi_set_named_property(env, error, "errno", code);
  napi_value name = NULL;
  napi_create_string_utf8(env, syscall, NAPI_AUTO_LENGTH, &name);
  napi_set_named_property(env, error, "syscall", name);
  napi_throw(env, error);
  return NULL;
}

static napi_value throw_type(napi_env env, const char *message) {
  napi_throw_type_error(env, NULL, message);
  return NULL;
}

static napi_value read_fd(napi_env env, napi_callback_info info, int32_t *fd) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    return throw_type(env, "file descriptor is required");
  }
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_number) {
    return throw_type(env, "file descriptor must be a number");
  }
  if (napi_get_value_int32(env, argv[0], fd) != napi_ok || *fd < 0) {
    return throw_type(env, "file descriptor must be a non-negative 32-bit integer");
  }
  return NULL;
}

static napi_value ReadPeerUid(napi_env env, napi_callback_info info) {
  int32_t fd = -1;
  napi_value failure = read_fd(env, info, &fd);
  if (failure != NULL) {
    return failure;
  }

  struct ucred credentials;
  socklen_t length = sizeof(credentials);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &length) != 0) {
    return throw_errno(env, "getsockopt");
  }
  if (length != sizeof(struct ucred)) {
    errno = EPROTO;
    return throw_errno(env, "getsockopt");
  }

  napi_value result = NULL;
  napi_create_uint32(env, (uint32_t)credentials.uid, &result);
  return result;
}

static napi_value LockFile(napi_env env, napi_callback_info info) {
  int32_t fd = -1;
  napi_value failure = read_fd(env, info, &fd);
  if (failure != NULL) {
    return failure;
  }
  if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
    return throw_errno(env, "flock");
  }
  napi_value result = NULL;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"readPeerUid", NULL, ReadPeerUid, NULL, NULL, NULL, napi_default, NULL},
      {"lockFile", NULL, LockFile, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
