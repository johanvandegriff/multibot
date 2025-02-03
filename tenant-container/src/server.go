package main

import (
	"encoding/gob"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/gorilla/mux"

	"multibot/common/env"
	"multibot/common/redisClient"
	"multibot/tenant-container/src/emotes"
	"multibot/tenant-container/src/frontend"
	"multibot/tenant-container/src/kickChat"
	"multibot/tenant-container/src/multiChat"
	"multibot/tenant-container/src/owncastChat"
	"multibot/tenant-container/src/props"
	"multibot/tenant-container/src/twitchChat"
	"multibot/tenant-container/src/youtubeApi"
	"multibot/tenant-container/src/youtubeChat"

	"multibot/common/redisSession"
)

const (
	ENABLED_COOLDOWN = 5 * time.Second //only let users enable/disable their channel every 5 seconds
)

var (
	enabledRateLimit time.Time // rate-limit toggling "enabled"
)

func main() {
	gob.Register(&redisSession.TwitchUser{})

	redisClient.Init()

	// Run first-run checks.
	go ensureFirstRun()

	// Set up property listeners
	props.AddChannelPropListener("youtube_id", func(oldValue, newValue interface{}) {
		log.Printf("youtube_id changed from %v to %v", oldValue, newValue)
		youtubeChat.DisconnectFromYouTube()
		youtubeChat.ConnectToYouTube()
	})
	props.AddChannelPropListener("owncast_url", func(oldValue, newValue interface{}) {
		log.Printf("owncast_url changed from %v to %v", oldValue, newValue)
		owncastChat.DisconnectFromOwncast()
		owncastChat.ConnectToOwncast()
	})
	props.AddChannelPropListener("kick_chatroom_id", func(oldValue, newValue interface{}) {
		log.Printf("kick_chatroom_id changed from %v to %v", oldValue, newValue)
		kickChat.DisconnectFromKick()
		kickChat.ConnectToKick()
	})
	props.AddChannelPropListener("enabled", func(oldValue, newValue interface{}) {
		log.Printf("enabled changed from %v to %v", oldValue, newValue)
		go func() {
			twitchChat.DisconnectFromTwitch()
			twitchChat.ConnectToTwitch()
		}()
		go func() {
			youtubeChat.DisconnectFromYouTube()
			youtubeChat.ConnectToYouTube()
		}()
		go func() {
			owncastChat.DisconnectFromOwncast()
			owncastChat.ConnectToOwncast()
		}()
		go func() {
			kickChat.DisconnectFromKick()
			kickChat.ConnectToKick()
		}()
	})
	props.AddViewerPropListener("nickname", func(username string, oldValue, newValue interface{}) {
		// If a user's nickname changes, update the chat history so old messages will show the new nickname
		log.Printf("nickname for %s changed from %v to %v", username, oldValue, newValue)
		nickname := ""
		if newValue == nil {
			nickname = ""
		} else if newNick, ok := newValue.(string); ok {
			nickname = newNick
		}
		multiChat.UpdateChatHistoryNickname(username, nickname)
	})

	// Start background tasks to attempt connections.
	go twitchChat.ConnectToTwitchLoop()
	go youtubeChat.ConnectToYouTubeLoop()
	go owncastChat.ConnectToOwncastLoop()
	go kickChat.ConnectToKickLoop()

	// fetch the pronoun list from pronouns.alejo.io at startup:
	go multiChat.LoadPronounMapOnce()

	// start a background cycle to keep your 3rd-party emotes updated:
	go emotes.EmoteCacheRefresher()

	// Setup HTTP routes.
	router := mux.NewRouter()

	// Register the session middleware so that all routes have session handling.
	router.Use(redisSession.SessionMiddleware)

	router.HandleFunc("/ws", multiChat.WsHandler)
	router.HandleFunc("/ws/num_clients", multiChat.WsNumClientsHandler)

	router.HandleFunc("/", indexHandler)
	router.HandleFunc("/chat", indexHandlerChat)
	router.PathPrefix("/static/").Handler(http.StripPrefix("/static/", http.FileServer(http.Dir("./static"))))

	// Serve everything under /tmi-utils from ./static/tmi-utils,
	// adding ".js" when the request has no extension.
	router.PathPrefix("/tmi-utils/").Handler(
		http.StripPrefix("/tmi-utils/",
			addJsIfNoExt(http.FileServer(http.Dir("./static/tmi-utils"))),
		),
	)

	router.HandleFunc("/channel_props/{prop_name}", getChannelPropHandler).Methods("GET")
	router.Handle("/channel_props/{prop_name}", channelAuthMiddleware(http.HandlerFunc(setChannelPropHandler))).Methods("POST")

	router.HandleFunc("/viewers", getAllViewersHandler).Methods("GET")
	router.Handle("/viewers/{username}", channelAuthMiddleware(http.HandlerFunc(deleteViewerHandler))).Methods("DELETE")
	router.HandleFunc("/viewers/{username}/{prop_name}", getViewerPropHandler).Methods("GET")
	router.Handle("/viewers/{username}/{prop_name}", channelAuthMiddleware(http.HandlerFunc(setViewerPropHandler))).Methods("POST")

	router.Handle("/clear_chat", channelAuthMiddleware(http.HandlerFunc(clearChatHandler))).Methods("POST")
	router.HandleFunc("/chat_history", chatHistoryHandler).Methods("GET")
	router.HandleFunc("/find_youtube_id", youtubeApi.FindYoutubeIDHandler).Methods("GET")

	router.HandleFunc("/status/twitch", statusTwitchHandler).Methods("GET")
	router.HandleFunc("/status/youtube", statusYouTubeHandler).Methods("GET")
	router.HandleFunc("/status/owncast", statusOwncastHandler).Methods("GET")
	router.HandleFunc("/status/kick", statusKickHandler).Methods("GET")
	router.HandleFunc("/status/emotes", statusEmotesHandler).Methods("GET")

	router.NotFoundHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		now := time.Now().UnixMilli()
		log.Printf("[tenant] 404 %d channel:%s req:%s", now, env.TWITCH_CHANNEL, r.URL.Path)
		fmt.Fprintf(w, `<h1>404 - Not Found</h1>
<p>The requested URL was not found on this server.</p>
<p><a href="/%s">back to channel page</a></p>
<p>[tenant] timestamp: %d</p>`, env.TWITCH_CHANNEL, now)
	})

	srv := &http.Server{
		Addr:    ":" + env.PORT,
		Handler: router,
	}
	log.Println("Tenant container listening on port", env.PORT)
	log.Fatal(srv.ListenAndServe())
}

// Middleware that appends ".js" if the requested path has no extension.
func addJsIfNoExt(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if path.Ext(p) == "" && !strings.HasSuffix(p, "/") {
			r.URL.Path = p + ".js"
		}
		next.ServeHTTP(w, r)
	})
}

// -----------------------------------------------------------------------------
//  Basic HTTP handlers
// -----------------------------------------------------------------------------

func indexHandler(w http.ResponseWriter, r *http.Request) {
	user, isSuperAdmin := redisSession.GetSessionUser(r)
	channels := props.ListChannels(r.Context())
	userBytes, _ := json.Marshal(user)

	data := map[string]any{
		"page_hash":          frontend.IndexPageHash,
		"user":               string(userBytes),
		"channel":            env.TWITCH_CHANNEL,
		"channels":           strings.Join(channels, ","),
		"is_super_admin":     isSuperAdmin,
		"enabled_cooldown":   ENABLED_COOLDOWN.Milliseconds(),
		"is_chat_fullscreen": false,
		"bgcolor":            "",
	}
	frontend.IndexTemplate.Execute(w, data)
}

func indexHandlerChat(w http.ResponseWriter, r *http.Request) {
	user, isSuperAdmin := redisSession.GetSessionUser(r)
	channels := props.ListChannels(r.Context())
	userBytes, _ := json.Marshal(user)

	bgcolor := r.URL.Query().Get("bgcolor")
	if bgcolor == "" {
		bgcolor = "transparent"
	}

	data := map[string]any{
		"page_hash":          frontend.IndexPageHash,
		"user":               string(userBytes),
		"channel":            env.TWITCH_CHANNEL,
		"channels":           strings.Join(channels, ","),
		"is_super_admin":     isSuperAdmin,
		"enabled_cooldown":   ENABLED_COOLDOWN.Milliseconds(),
		"is_chat_fullscreen": true,
		"bgcolor":            bgcolor,
	}
	frontend.IndexTemplate.Execute(w, data)
}

// --------------------------------------------------
// Handlers for each /status/* route
// --------------------------------------------------

// /status/twitch
func statusTwitchHandler(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, twitchChat.GetStatus())
}

// /status/youtube
func statusYouTubeHandler(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, youtubeChat.GetStatus())
}

// /status/owncast
func statusOwncastHandler(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, owncastChat.GetStatus())
}

// /status/kick
func statusKickHandler(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, kickChat.GetStatus())
}

// /status/emotes
func statusEmotesHandler(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, emotes.GetStatus())
}

func respondJSON(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	if err := enc.Encode(data); err != nil {
		log.Println("respondJSON error:", err)
	}
}

// -----------------------------------------------------------------------------
//  Channel/viewer props
// -----------------------------------------------------------------------------

func getChannelPropHandler(w http.ResponseWriter, r *http.Request) {
	propName := mux.Vars(r)["prop_name"]
	val := props.GetChannelProp(r.Context(), propName)
	b, _ := json.Marshal(val)
	w.Write(b)
}

func setChannelPropHandler(w http.ResponseWriter, r *http.Request) {
	propName := mux.Vars(r)["prop_name"]
	var body struct {
		PropValue any `json:"prop_value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	if propName == "enabled" {
		now := time.Now()
		if now.Sub(enabledRateLimit) < ENABLED_COOLDOWN {
			w.Write([]byte("wait"))
			return
		}
		enabledRateLimit = now
	}

	props.SetChannelProp(r.Context(), propName, body.PropValue)
	w.Write([]byte("ok"))
}

func getAllViewersHandler(w http.ResponseWriter, r *http.Request) {
	viewers := props.ListViewers(r.Context())
	data := make(map[string]map[string]any)
	for _, v := range viewers {
		props, _ := props.GetAllViewerProps(r.Context(), v)
		data[v] = props
	}
	b, _ := json.Marshal(data)
	w.Header().Set("Content-Type", "application/json")
	w.Write(b)
}

func deleteViewerHandler(w http.ResponseWriter, r *http.Request) {
	username := mux.Vars(r)["username"]
	props.DeleteViewer(r.Context(), username)
	w.Write([]byte("ok"))
}

func getViewerPropHandler(w http.ResponseWriter, r *http.Request) {
	username := mux.Vars(r)["username"]
	propName := mux.Vars(r)["prop_name"]
	val := props.GetViewerProp(r.Context(), username, propName)
	b, _ := json.Marshal(val)
	w.Header().Set("Content-Type", "application/json")
	w.Write(b)
}

func setViewerPropHandler(w http.ResponseWriter, r *http.Request) {
	username := mux.Vars(r)["username"]
	propName := mux.Vars(r)["prop_name"]

	var body struct {
		PropValue any `json:"prop_value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	if _, ok := props.DEFAULT_VIEWER_PROPS[propName]; !ok {
		http.Error(w, "invalid prop_name", http.StatusBadRequest)
		return
	}

	props.SetViewerProp(r.Context(), username, propName, body.PropValue)
	w.Write([]byte("ok"))
}

// -----------------------------------------------------------------------------
//  Chat utilities
// -----------------------------------------------------------------------------

func clearChatHandler(w http.ResponseWriter, r *http.Request) {
	multiChat.ClearChat()
	w.Write([]byte("ok"))
}

func chatHistoryHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write(multiChat.GetChatHistoryJSON())
}

func channelAuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, isSuperAdmin := redisSession.GetSessionUser(r)
		if user == nil {
			http.Error(w, "Forbidden (no user in session)", http.StatusForbidden)
			return
		}
		if strings.EqualFold(user.Login, env.TWITCH_CHANNEL) || isSuperAdmin {
			next.ServeHTTP(w, r)
		} else {
			http.Error(w, "Forbidden (not channel owner or super admin)", http.StatusForbidden)
		}
	})
}

func ensureFirstRun() {
	didFirstRun := props.GetChannelProp(nil, "did_first_run").(bool)

	if !didFirstRun {
		log.Println("FIRST RUN logic: clearing viewer data, channel props, etc.")
		props.ClearChannelAndViewerProps(nil)
		props.SetViewerProp(nil, env.TWITCH_BOT_USERNAME, "nickname", env.DEFAULT_BOT_NICKNAME)
		props.SetChannelProp(nil, "did_first_run", true)
	}
}
