package redisClient

import (
	"context"
	"log"
	"time"

	"github.com/redis/go-redis/v9"

	"multibot/common/env"
)

const (
	NAMESPACE = "multibot"
	PREDIS    = NAMESPACE + ":"
)

var (
	r *redis.Client
	b = context.Background()
)

func Init() {
	opt, err := redis.ParseURL(env.STATE_DB_URL)
	if err != nil {
		log.Fatalf("failed to parse redis URL: %v", err)
	}
	opt.Password = env.STATE_DB_PASSWORD
	r = redis.NewClient(opt)
	if err := r.Ping(b).Err(); err != nil {
		log.Fatalf("redis ping error: %v", err)
	}
	log.Println("Connected to Redis!")
}

// default to background context if none given
func c(ctx context.Context) context.Context {
	if ctx == nil {
		return b
	} else {
		return ctx
	}
}

func Set(ctx context.Context, key string, value interface{}, expiration time.Duration) *redis.StatusCmd {
	return r.Set(c(ctx), PREDIS+key, value, expiration)
}

func Get(ctx context.Context, key string) *redis.StringCmd {
	return r.Get(c(ctx), PREDIS+key)
}

func Incr(ctx context.Context, key string) *redis.IntCmd {
	return r.Incr(c(ctx), PREDIS+key)
}

// MGet wraps redis.Client.MGet for multiple keys by prefixing each key.
func MGet(ctx context.Context, keys ...string) *redis.SliceCmd {
	prefixedKeys := make([]string, len(keys))
	for i, key := range keys {
		prefixedKeys[i] = PREDIS + key
	}
	return r.MGet(c(ctx), prefixedKeys...)
}

func SMembers(ctx context.Context, key string) *redis.StringSliceCmd {
	return r.SMembers(c(ctx), PREDIS+key)
}

func Del(ctx context.Context, keys ...string) *redis.IntCmd {
	prefixedKeys := make([]string, len(keys))
	for i, key := range keys {
		prefixedKeys[i] = PREDIS + key
	}
	return r.Del(c(ctx), prefixedKeys...)
}

func HGet(ctx context.Context, key, field string) *redis.StringCmd {
	return r.HGet(c(ctx), PREDIS+key, field)
}

func HGetAll(ctx context.Context, key string) *redis.MapStringStringCmd {
	return r.HGetAll(c(ctx), PREDIS+key)
}

func HDel(ctx context.Context, key string, fields ...string) *redis.IntCmd {
	return r.HDel(c(ctx), PREDIS+key, fields...)
}

func SAdd(ctx context.Context, key string, members ...interface{}) *redis.IntCmd {
	return r.SAdd(c(ctx), PREDIS+key, members...)
}

func HSet(ctx context.Context, key string, values ...interface{}) *redis.IntCmd {
	return r.HSet(c(ctx), PREDIS+key, values...)
}

func SRem(ctx context.Context, key string, members ...interface{}) *redis.IntCmd {
	return r.SRem(c(ctx), PREDIS+key, members...)
}

func SIsMember(ctx context.Context, key string, member interface{}) *redis.BoolCmd {
	return r.SIsMember(c(ctx), PREDIS+key, member)
}
