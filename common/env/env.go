package env

import (
	"os"
	"strconv"
)

var (
	DISABLE_K8S                 = os.Getenv("DISABLE_K8S") == "true" //main
	DOCKER_USERNAME             = os.Getenv("DOCKER_USERNAME") //main
	IMAGE_PULL_POLICY           = os.Getenv("IMAGE_PULL_POLICY") //main
	PROXY_OVERRIDES             = os.Getenv("PROXY_OVERRIDES") //main

	TWITCH_SUPER_ADMIN_USERNAME = os.Getenv("TWITCH_SUPER_ADMIN_USERNAME") //main, tenant
	TWITCH_CLIENT_ID            = os.Getenv("TWITCH_CLIENT_ID") //main, tenant
	TWITCH_SECRET               = os.Getenv("TWITCH_SECRET") //main, tenant
	BASE_URL                    = os.Getenv("BASE_URL") //main, tenant
	PORT                        = getEnvDefault("PORT", "80") //main, tenant

	TWITCH_CHANNEL              = os.Getenv("TWITCH_CHANNEL") //tenant
	TWITCH_BOT_USERNAME         = os.Getenv("TWITCH_BOT_USERNAME") //tenant
	TWITCH_BOT_OAUTH_TOKEN      = os.Getenv("TWITCH_BOT_OAUTH_TOKEN") //tenant
	DEFAULT_BOT_NICKNAME        = getEnvDefault("DEFAULT_BOT_NICKNAME", "🤖") //tenant
	CHAT_HISTORY_LENGTH         = getEnvDefaultInt("CHAT_HISTORY_LENGTH", 100) //tenant
)

func getEnvDefault(key string, defaultValue string) string {
	value := os.Getenv(key)
	if value == "" {
		return defaultValue
	}
	return value
}

func getEnvDefaultInt(key string, defaultValue int) int {
	value := os.Getenv(key)
	if value == "" {
		return defaultValue
	}
	i, err := strconv.Atoi(value)
    if err != nil {
		return defaultValue
    }
	return i
}
