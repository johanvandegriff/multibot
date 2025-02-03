module multibot/tenant-container

go 1.23

toolchain go1.23.5

// replace github.com/johanvandegriff/kick-chat-wrapper => /home/user/git/johanvandegriff/kick-chat-wrapper

require (
	github.com/TwiN/go-away v1.6.14
	github.com/abhinavxd/youtube-live-chat-downloader/v2 v2.0.3
	github.com/gempir/go-twitch-irc/v4 v4.2.0
	github.com/google/uuid v1.6.0
	github.com/gorilla/mux v1.8.1
	github.com/gorilla/websocket v1.5.3
	github.com/johanvandegriff/kick-chat-wrapper v0.0.0-20250202052742-a566d4cbe8ff
	github.com/redis/go-redis/v9 v9.7.0
)

require (
	github.com/cespare/xxhash/v2 v2.2.0 // indirect
	github.com/dgryski/go-rendezvous v0.0.0-20200823014737-9f7001d12a5f // indirect
	golang.org/x/text v0.20.0 // indirect
)
