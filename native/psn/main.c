#include <chiaki/session.h>
#include <chiaki/base64.h>
#include <chiaki/remote/holepunch.h>
#include <json-c/json.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

static json_object *registration;

static const char *field(json_object *object, const char *name)
{
    json_object *value;
    if (!json_object_object_get_ex(object, name, &value) || !json_object_is_type(value, json_type_string)) return NULL;
    return json_object_get_string(value);
}

static void add_hex(json_object *object, const char *key, const uint8_t *bytes, size_t size)
{
    char output[size * 2 + 1];
    for (size_t i = 0; i < size; i++) snprintf(output + i * 2, 3, "%02x", bytes[i]);
    json_object_object_add(object, key, json_object_new_string(output));
}

static bool parse_hex(const char *value, uint8_t *bytes, size_t size)
{
    if (!value || strlen(value) != size * 2) return false;
    for (size_t i = 0; i < size; i++)
    {
        if (!isxdigit((unsigned char)value[i * 2]) || !isxdigit((unsigned char)value[i * 2 + 1])) return false;
        char pair[] = {value[i * 2], value[i * 2 + 1], 0};
        char *end;
        long number = strtol(pair, &end, 16);
        if (*end || number < 0 || number > 255) return false;
        bytes[i] = (uint8_t)number;
    }
    return true;
}

static void session_event(ChiakiEvent *event, void *user)
{
    if (event->type != CHIAKI_EVENT_REGIST) return;
    const ChiakiRegisteredHost *host = &event->host;
    registration = json_object_new_object();
    json_object_object_add(registration, "name", json_object_new_string_len(host->server_nickname, strnlen(host->server_nickname, sizeof(host->server_nickname))));
    add_hex(registration, "mac", host->server_mac, sizeof(host->server_mac));
    add_hex(registration, "registKey", (const uint8_t *)host->rp_regist_key, sizeof(host->rp_regist_key));
    add_hex(registration, "rpKey", host->rp_key, sizeof(host->rp_key));
    json_object_object_add(registration, "keyType", json_object_new_int64(host->rp_key_type));
}

static json_object *list_devices(const char *token, ChiakiLog *log)
{
    ChiakiHolepunchDeviceInfo *devices = NULL;
    size_t count = 0;
    if (chiaki_holepunch_list_devices(token, CHIAKI_HOLEPUNCH_CONSOLE_TYPE_PS5, &devices, &count, log) != CHIAKI_ERR_SUCCESS) return NULL;
    json_object *result = json_object_new_array();
    for (size_t i = 0; i < count; i++)
    {
        if (!devices[i].remoteplay_enabled) continue;
        json_object *device = json_object_new_object();
        json_object_object_add(device, "name", json_object_new_string_len(devices[i].device_name, strnlen(devices[i].device_name, sizeof(devices[i].device_name))));
        json_object_object_add(device, "type", json_object_new_string("PS5"));
        add_hex(device, "uid", devices[i].device_uid, sizeof(devices[i].device_uid));
        json_object_array_add(result, device);
    }
    chiaki_holepunch_free_device_list(&devices);
    json_object *ps4 = json_object_new_object();
    json_object_object_add(ps4, "name", json_object_new_string("Main PS4 Console"));
    json_object_object_add(ps4, "type", json_object_new_string("PS4"));
    json_object_object_add(ps4, "uid", json_object_new_string("4141414141414141414141414141414141414141414141414141414141414141"));
    json_object_array_add(result, ps4);
    return result;
}

static json_object *pair_console(json_object *request, const char *token, ChiakiLog *log)
{
    uint8_t uid[32];
    const char *type = field(request, "type");
    const char *account_id = field(request, "accountId");
    if (!type || (strcmp(type, "PS5") && strcmp(type, "PS4")) || !account_id || !parse_hex(field(request, "uid"), uid, sizeof(uid))) return NULL;
    ChiakiConnectInfo info = {0};
    size_t account_size = sizeof(info.psn_account_id);
    if (chiaki_base64_decode(account_id, strlen(account_id), info.psn_account_id, &account_size) != CHIAKI_ERR_SUCCESS || account_size != sizeof(info.psn_account_id)) return NULL;
    info.ps5 = !strcmp(type, "PS5");
    info.auto_regist = true;
    info.audio_video_disabled = true;
    info.packet_loss_max = 0.01;
    info.holepunch_session = chiaki_holepunch_session_init(token, log);
    if (!info.holepunch_session) return NULL;
    ChiakiHolepunchSession hole = info.holepunch_session;
    chiaki_holepunch_upnp_discover(hole);
    if (chiaki_holepunch_session_create(hole) != CHIAKI_ERR_SUCCESS ||
        holepunch_session_create_offer(hole) != CHIAKI_ERR_SUCCESS ||
        chiaki_holepunch_session_start(hole, uid, info.ps5 ? CHIAKI_HOLEPUNCH_CONSOLE_TYPE_PS5 : CHIAKI_HOLEPUNCH_CONSOLE_TYPE_PS4) != CHIAKI_ERR_SUCCESS ||
        chiaki_holepunch_session_punch_hole(hole, CHIAKI_HOLEPUNCH_PORT_TYPE_CTRL) != CHIAKI_ERR_SUCCESS)
    {
        chiaki_holepunch_session_fini(hole);
        return NULL;
    }
    ChiakiSession session;
    if (chiaki_session_init(&session, &info, log) != CHIAKI_ERR_SUCCESS) return NULL;
    chiaki_session_set_event_cb(&session, session_event, NULL);
    if (chiaki_session_start(&session) == CHIAKI_ERR_SUCCESS) chiaki_session_join(&session);
    chiaki_session_fini(&session);
    return registration;
}

int main(void)
{
    if (chiaki_lib_init() != CHIAKI_ERR_SUCCESS) return 1;
    char input[32768];
    if (!fgets(input, sizeof(input), stdin) || !strchr(input, '\n')) return 2;
    json_object *request = json_tokener_parse(input);
    if (!request) return 2;
    const char *operation = field(request, "operation");
    const char *token = field(request, "accessToken");
    if (!operation || !token || !*token || strlen(token) > 8192) { json_object_put(request); return 2; }
    ChiakiLog log;
    chiaki_log_init(&log, 0, NULL, NULL);
    json_object *result = NULL;
    if (!strcmp(operation, "list")) result = list_devices(token, &log);
    else if (!strcmp(operation, "pair")) result = pair_console(request, token, &log);
    if (result) { puts(json_object_to_json_string_ext(result, JSON_C_TO_STRING_PLAIN)); json_object_put(result); }
    json_object_put(request);
    return result ? 0 : 1;
}
