package props

import (
	"context"
	"encoding/json"
	"log"
	"multibot/common/env"
	"multibot/common/redisClient"
	"multibot/tenant-container/src/multiChat"
	"time"

	"github.com/redis/go-redis/v9"
)

var (
	DEFAULT_CHANNEL_PROPS = map[string]interface{}{
		"enabled":             true,
		"did_first_run":       false,
		"fwd_cmds_yt_twitch":  []string{"!sr", "!test"},
		"max_nickname_length": 20,
		"greetz_threshold":    (5 * time.Hour).Milliseconds(),     //TODO
		"greetz_wb_threshold": (3 / 4 * time.Hour).Milliseconds(), //TODO
		"youtube_id":          "",
		"owncast_url":         "",
		"kick_username":       "",
		"kick_chatroom_id":    "",
		"show_usernames":      true, // Whether to show certain data in the rendered chat
		"show_nicknames":      true,
		"show_pronouns":       true,
		"text_shadow":         "1px 1px 2px black",
		"font":                `"Cabin", "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif`,
	}
	DEFAULT_VIEWER_PROPS = map[string]interface{}{
		"nickname":      nil,
		"custom_greetz": nil,
	}

	// Store listeners for channel/viewer props
	channelPropListeners = make(map[string][]func(oldValue, newValue interface{}))
	viewerPropListeners  = make(map[string][]func(username string, oldValue, newValue interface{}))
)

func channelPropKey(propName string) string {
	return "channels/" + env.TWITCH_CHANNEL + "/channel_props/" + propName
}

func viewerKey(username string) string {
	return "channels/" + env.TWITCH_CHANNEL + "/viewers/" + username
}

func AddChannelPropListener(propName string, fn func(oldValue, newValue interface{})) {
	channelPropListeners[propName] = append(channelPropListeners[propName], fn)
}

func AddViewerPropListener(propName string, fn func(username string, oldVal, newVal interface{})) {
	viewerPropListeners[propName] = append(viewerPropListeners[propName], fn)
}

func ListChannels(ctx context.Context) []string {
	channels, _ := redisClient.SMembers(ctx, "channels").Result()
	return channels
}

func ListViewers(ctx context.Context) []string {
	viewers, _ := redisClient.SMembers(ctx, "channels/"+env.TWITCH_CHANNEL+"/viewers").Result()
	return viewers
}

func GetChannelProp(ctx context.Context, propName string) any {
	val, err := redisClient.Get(ctx, channelPropKey(propName)).Result()
	if err == redis.Nil || err != nil {
		if defVal, ok := DEFAULT_CHANNEL_PROPS[propName]; ok {
			return defVal
		}
		return nil
	}
	var out any
	if err := json.Unmarshal([]byte(val), &out); err != nil {
		log.Printf("[prop] Failed to unmarshal property %s: %v", propName, err)
		// If unmarshaling fails, use default if available
		if defVal, ok := DEFAULT_CHANNEL_PROPS[propName]; ok {
			return defVal
		}
		return nil
	}
	return out
}

func GetChannelPropAs[T int | int64 | float64](ctx context.Context, propName string, defaultValue T) T {
	v := GetChannelProp(ctx, propName)
	var defaultValueAny any = defaultValue

	switch defaultValueAny.(type) {
	case int: //T = int
		if v == nil {
			return 0
		}
		switch v.(type) {
		case int:
			return v.(T)
		case int64:
			return T(v.(int64))
		case float64:
			return T(v.(float64))
		default:
			return 0
		}
	case int64: //T = int64
		if v == nil {
			return 0
		}
		switch v.(type) {
		case int:
			return T(v.(int))
		case int64:
			return v.(T)
		case float64:
			return T(v.(float64))
		default:
			return 0
		}
	case float64: //T = float64
		if v == nil {
			return 0
		}
		switch v.(type) {
		case float64:
			return v.(T)
		case int:
			return T(v.(int))
		case int64:
			return T(v.(int64))
		default:
			return 0
		}
	}
	return defaultValue
}

func SetChannelProp(ctx context.Context, propName string, propValue interface{}) {
	// check old value if needed
	var oldVal interface{}
	if listeners, exists := channelPropListeners[propName]; exists && len(listeners) > 0 {
		oldVal = GetChannelProp(ctx, propName)
	}

	if propValue == nil {
		redisClient.Del(ctx, channelPropKey(propName))
	} else {
		raw, _ := json.Marshal(propValue)
		redisClient.Set(ctx, channelPropKey(propName), raw, 0)
	}
	multiChat.Broadcast("channel_prop", map[string]any{
		"prop_name":  propName,
		"prop_value": propValue,
	})

	// trigger listeners if changed
	if listeners, exists := channelPropListeners[propName]; exists && oldVal != propValue {
		for _, fn := range listeners {
			fn(oldVal, propValue)
		}
	}
}

func GetViewerProp(ctx context.Context, username, propName string) any {
	val, err := redisClient.HGet(ctx, viewerKey(username), propName).Result()
	if err == redis.Nil {
		if defVal, ok := DEFAULT_VIEWER_PROPS[propName]; ok {
			return defVal
		}
		return nil
	} else if err != nil {
		return nil
	}
	var out any
	json.Unmarshal([]byte(val), &out)
	return out
}

func GetAllViewerProps(ctx context.Context, username string) (map[string]any, error) {
	hash, err := redisClient.HGetAll(ctx, viewerKey(username)).Result()
	if err != nil {
		return nil, err
	}
	res := make(map[string]any)
	for k, v := range hash {
		var tmp any
		json.Unmarshal([]byte(v), &tmp)
		res[k] = tmp
	}
	return res, nil
}

func SetViewerProp(ctx context.Context, username, propName string, propValue interface{}) {
	var oldVal interface{}
	listeners, hasListeners := viewerPropListeners[propName]
	if hasListeners && len(listeners) > 0 {
		oldVal = GetViewerProp(ctx, username, propName)
	}
	if propValue == nil {
		redisClient.HDel(ctx, viewerKey(username), propName)
	} else {
		redisClient.SAdd(ctx, "channels/"+env.TWITCH_CHANNEL+"/viewers", username)
		raw, _ := json.Marshal(propValue)
		redisClient.HSet(ctx, viewerKey(username), propName, string(raw))
	}
	multiChat.Broadcast("viewer_prop", map[string]any{
		"username":   username,
		"prop_name":  propName,
		"prop_value": propValue,
	})
	if hasListeners && oldVal != propValue {
		for _, fn := range listeners {
			fn(username, oldVal, propValue)
		}
	}
}

func DeleteViewer(ctx context.Context, username string) {
	// If you want to trigger “oldValue => nilValue” for each property:
	props, _ := GetAllViewerProps(ctx, username)
	for propName, oldVal := range props {
		if listFns, exists := viewerPropListeners[propName]; exists {
			for _, fn := range listFns {
				fn(username, oldVal, nil)
			}
		}
	}
	redisClient.SRem(ctx, "channels/"+env.TWITCH_CHANNEL+"/viewers", username)
	redisClient.Del(ctx, viewerKey(username))
	multiChat.Broadcast("delete_viewer", map[string]any{"username": username})
}

func ClearChannelAndViewerProps(ctx context.Context) {
	viewerSetKey := "channels/" + env.TWITCH_CHANNEL + "/viewers"
	viewers, _ := redisClient.SMembers(ctx, viewerSetKey).Result()
	for _, v := range viewers {
		redisClient.Del(ctx, viewerKey(v))
	}
	redisClient.Del(ctx, viewerSetKey)
	for propName := range DEFAULT_CHANNEL_PROPS {
		redisClient.Del(ctx, channelPropKey(propName))
	}
}
