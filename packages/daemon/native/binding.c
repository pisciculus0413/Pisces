#include <errno.h>
#include <node_api.h>
#include <string.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/un.h>
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
  double value = 0.0;
  if (napi_get_value_double(env, argv[0], &value) != napi_ok) {
    return throw_type(env, "file descriptor must be a number");
  }
  /* Reject before any conversion or syscall: N-API would otherwise truncate
     fractional and wrap out-of-range values into a different descriptor. */
  if (!(value >= 0.0) || value > 2147483647.0 || value != (double)(int32_t)value) {
    return throw_type(env, "file descriptor must be a non-negative 32-bit integer");
  }
  *fd = (int32_t)value;
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

static napi_value BindUnixListener(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    return throw_type(env, "socket path is required");
  }
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_string) {
    return throw_type(env, "socket path must be a string");
  }

  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  size_t length = 0;
  if (napi_get_value_string_utf8(env, argv[0], NULL, 0, &length) != napi_ok) {
    return throw_type(env, "socket path must be valid UTF-8");
  }
  if (length == 0 || length > sizeof(address.sun_path) - 1) {
    return throw_type(env, "socket path length is invalid");
  }
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, argv[0], address.sun_path, sizeof(address.sun_path),
                                 &copied) != napi_ok ||
      copied != length) {
    return throw_type(env, "socket path could not be read");
  }
  /* An embedded NUL would silently truncate the pathname and bind elsewhere. */
  if (strlen(address.sun_path) != copied) {
    return throw_type(env, "socket path must not contain NUL");
  }
  address.sun_family = AF_UNIX;

  const int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) {
    return throw_errno(env, "socket");
  }
  if (bind(fd, (const struct sockaddr *)&address, sizeof(address)) != 0) {
    const int saved = errno;
    close(fd);
    errno = saved;
    return throw_errno(env, "bind");
  }
  if (listen(fd, SOMAXCONN) != 0) {
    const int saved = errno;
    close(fd);
    errno = saved;
    return throw_errno(env, "listen");
  }

  napi_value result = NULL;
  napi_create_int32(env, fd, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"readPeerUid", NULL, ReadPeerUid, NULL, NULL, NULL, napi_default, NULL},
      {"lockFile", NULL, LockFile, NULL, NULL, NULL, napi_default, NULL},
      {"bindUnixListener", NULL, BindUnixListener, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
