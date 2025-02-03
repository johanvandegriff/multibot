package main

import (
	"context"
	"crypto/sha256"
	"encoding/gob"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"

	goaway "github.com/TwiN/go-away"

	YtChat "github.com/abhinavxd/youtube-live-chat-downloader/v2"
	twitch "github.com/gempir/go-twitch-irc/v4"
	kickchatwrapper "github.com/johanvandegriff/kick-chat-wrapper"

	"multibot/tenant-container/src/emotes"
	"multibot/tenant-container/src/twitchApi"

	"multibot/common/redisSession"
)

var (
	TWITCH_CHANNEL              = os.Getenv("TWITCH_CHANNEL")
	TWITCH_SUPER_ADMIN_USERNAME = os.Getenv("TWITCH_SUPER_ADMIN_USERNAME")
	TWITCH_BOT_USERNAME         = os.Getenv("TWITCH_BOT_USERNAME")
	TWITCH_BOT_OAUTH_TOKEN      = os.Getenv("TWITCH_BOT_OAUTH_TOKEN")
	TWITCH_CLIENT_ID            = os.Getenv("TWITCH_CLIENT_ID")
	TWITCH_SECRET               = os.Getenv("TWITCH_SECRET")
	BASE_URL                    = os.Getenv("BASE_URL")

	CHAT_HISTORY_LENGTH = 100
	HOUR_IN_MS          = 60 * 60 * 1000

	DEFAULT_CHANNEL_PROPS = map[string]interface{}{
		"enabled":             true,
		"did_first_run":       false,
		"fwd_cmds_yt_twitch":  []string{"!sr", "!test"},
		"max_nickname_length": 20,
		"greetz_threshold":    5 * HOUR_IN_MS,
		"greetz_wb_threshold": int(0.75 * float64(HOUR_IN_MS)),
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
	DEFAULT_BOT_NICKNAME     = "🤖"
	ENABLED_COOLDOWN         = 5 * time.Second        //only let users enable/disable their channel every 5 seconds
	TWITCH_MESSAGE_DELAY     = 500 * time.Millisecond //time to wait between twitch chats for both to go thru
	YOUTUBE_MAX_MESSAGE_AGE  = 60 * time.Second
	YOUTUBE_CHECK_INTERVAL   = 1 * time.Minute
	OWNCAST_CHECK_INTERVAL   = 1 * time.Minute
	KICK_CHECK_INTERVAL      = 1 * time.Minute
	EMOTE_STARTUP_DELAY      = 2 * time.Minute
	EMOTE_CACHE_TIME         = 1 * time.Hour
	EMOTE_RETRY_TIME         = 30 * time.Second
	PRONOUN_CACHE_TIME       = 24 * time.Hour
	PRONOUN_RETRY_TIME       = 30 * time.Second
	GREETZ_DELAY_FOR_COMMAND = 2 * time.Second //wait to greet when the user ran a command

	GREETZ = []string{
		"yo #",
		"yo #",
		"yo yo #",
		"yo yo yo #",
		"yo yo yo # whats up!",
		"heyo #",
		"yooo # good to see u",
		"good to see u #",
		"hi #",
		"hello #",
		"helo #",
		"whats up #",
		"hey #, whats up?",
		"welcome #",
		"welcome in, #",
		"greetings #",
		"hows it going #",
		"hey whats new with you #",
		"how have you been #",
		"#!",
	}
	GREETZ_ALSO = []string{
		"also hi #",
		"also hi # whats up!",
		"also its good to see u #",
		"also whats up #",
		"also, whats up #?",
		"also welcome #",
		"also welcome in, #",
		"also welcome to chat, #",
		"also welcome to the stream, #",
		"also hows it going #",
		"also how have you been #",
	}
	GREETZ_WELCOME_BACK = []string{
		"welcome back #",
		"welcome back in, #",
		"welcome back to chat, #",
		"good to see u again #",
		"hello again #",
		"hi again #",
	}
	GREETZ_WELCOME_BACK_ALSO = []string{
		"also welcome back #",
		"also welcome back in, #",
		"also welcome back to chat, #",
		"also good to see u again #",
		"also hello again #",
		"also hi again #",
	}

	// Store listeners for channel/viewer props
	channelPropListeners = make(map[string][]func(oldValue, newValue interface{}))
	viewerPropListeners  = make(map[string][]func(username string, oldValue, newValue interface{}))

	// Redis, sessions, template, etc.
	indexTemplate    *template.Template
	indexPageHash    string
	enabledRateLimit time.Time // rate-limit toggling "enabled"

	wsUpgrader = websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		CheckOrigin:     func(r *http.Request) bool { return true },
	}
	wsClients   sync.Map // map[*WSConn]bool
	chatHistory = make([]ChatMessage, 0, CHAT_HISTORY_LENGTH)

	twitchConnected  bool
	youtubeConnected bool
	owncastConnected bool
	kickConnected    bool

	twitchClient   *twitch.Client
	youtubeCancel  context.CancelFunc
	youtubeWG      sync.WaitGroup
	owncastConn    *websocket.Conn
	owncastCloseMu sync.Mutex // to guard owncastConn
	kickClient     *kickchatwrapper.Client

	// Greet tracking: lastSeens stores last time a user talked (in ms).
	lastSeens     = make(map[string]int64)
	lastSeensLock sync.Mutex

	pronounCache = make(map[string]*pronounEntry)
	pronounLock  sync.Mutex

	// Some default known pronoun mappings from pronouns.alejo.io
	possiblePronouns = map[string]string{
		"aeaer":    "Ae/Aer",
		"any":      "Any", //not in the api response anymore
		"eem":      "E/Em",
		"faefaer":  "Fae/Faer",
		"hehim":    "He/Him",
		"heshe":    "He/She",
		"hethem":   "He/They",
		"itits":    "It/Its",
		"other":    "Other", //not in the api response anymore
		"perper":   "Per/Per",
		"sheher":   "She/Her",
		"shethem":  "She/They",
		"theythem": "They/Them",
		"vever":    "Ve/Ver",
		"xexem":    "Xe/Xem",
		"ziehir":   "Zie/Hir",
	}
)

// pronounEntry holds details about a user’s pronoun lookup.
type pronounEntry struct {
	Pronouns        string    // e.g. "He/Him"
	LastUpdated     time.Time // when we last finalized the pronoun
	StartedUpdating time.Time // when we started an update attempt
}

type twitchUser struct {
	ID              string `json:"id"`
	Login           string `json:"login"`
	DisplayName     string `json:"display_name"`
	Type            string `json:"type"`
	BroadcasterType string `json:"broadcaster_type"`
	Description     string `json:"description"`
	ProfileImageUrl string `json:"profile_image_url"`
	OfflineImageUrl string `json:"offline_image_url"`
	ViewCount       int    `json:"view_count"`
	Email           string `json:"email"`
	CreatedAt       string `json:"created_at"`
}

type ChatMessage struct {
	Source   string              `json:"source"`
	Username string              `json:"username"`
	Nickname string              `json:"nickname"`
	Pronouns string              `json:"pronouns"`
	Color    string              `json:"color"`
	Emotes   map[string][]string `json:"emotes"`
	Text     string              `json:"text"`
}

func main() {
	gob.Register(&twitchUser{})

	redisSession.Init()

	// Run first-run checks.
	go ensureFirstRun()

	// Load index.html from disk.
	indexHTMLBytes, err := os.ReadFile("index.html")
	if err != nil {
		log.Println("Cannot read index.html:", err)
		indexHTMLBytes = []byte(`<html><body><h1>tenant container fallback index</h1></body></html>`)
	}
	indexPageHash = sha256sum(indexHTMLBytes)
	indexTemplate = template.Must(template.New("index.html").Parse(string(indexHTMLBytes)))

	// Set up property listeners
	addChannelPropListener("youtube_id", func(oldValue, newValue interface{}) {
		log.Printf("youtube_id changed from %v to %v", oldValue, newValue)
		disconnectFromYouTube()
		connectToYouTube()
	})
	addChannelPropListener("owncast_url", func(oldValue, newValue interface{}) {
		log.Printf("owncast_url changed from %v to %v", oldValue, newValue)
		disconnectFromOwncast()
		connectToOwncast()
	})
	addChannelPropListener("kick_chatroom_id", func(oldValue, newValue interface{}) {
		log.Printf("kick_chatroom_id changed from %v to %v", oldValue, newValue)
		disconnectFromKick()
		connectToKick()
	})
	addChannelPropListener("enabled", func(oldValue, newValue interface{}) {
		log.Printf("enabled changed from %v to %v", oldValue, newValue)
		go func() {
			disconnectFromTwitch()
			connectToTwitch()
		}()
		go func() {
			disconnectFromYouTube()
			connectToYouTube()
		}()
		go func() {
			disconnectFromOwncast()
			connectToOwncast()
		}()
		go func() {
			disconnectFromKick()
			connectToKick()
		}()
	})
	addViewerPropListener("nickname", func(username string, oldValue, newValue interface{}) {
		log.Printf("nickname for %s changed from %v to %v", username, oldValue, newValue)
		// If a user's nickname changes, update the chat history so old messages will show the new nickname
		for i, msg := range chatHistory {
			if msg.Username == username {
				if newValue == nil {
					chatHistory[i].Nickname = ""
				} else if newNick, ok := newValue.(string); ok {
					chatHistory[i].Nickname = newNick
				}
			}
		}
	})

	// Start background tasks to attempt connections.
	go connectToTwitchLoop()
	go connectToYouTubeLoop()
	go connectToOwncastLoop()
	go connectToKickLoop()

	// fetch the pronoun list from pronouns.alejo.io at startup:
	go loadPronounMapOnce()

	// start a background cycle to keep your 3rd-party emotes updated:
	go emoteCacheRefresher()

	// Setup HTTP routes.
	router := mux.NewRouter()

	// Register the session middleware so that all routes have session handling.
	router.Use(redisSession.SessionMiddleware)

	router.HandleFunc("/ws", wsHandler)
	router.HandleFunc("/ws/num_clients", wsNumClientsHandler)

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
	router.HandleFunc("/find_youtube_id", findYoutubeIDHandler).Methods("GET")

	router.HandleFunc("/status/twitch", statusTwitchHandler).Methods("GET")
	router.HandleFunc("/status/youtube", statusYouTubeHandler).Methods("GET")
	router.HandleFunc("/status/owncast", statusOwncastHandler).Methods("GET")
	router.HandleFunc("/status/kick", statusKickHandler).Methods("GET")
	router.HandleFunc("/status/emotes", statusEmotesHandler).Methods("GET")

	router.NotFoundHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		now := time.Now().UnixMilli()
		log.Printf("[tenant] 404 %d channel:%s req:%s", now, TWITCH_CHANNEL, r.URL.Path)
		fmt.Fprintf(w, `<h1>404 - Not Found</h1>
<p>The requested URL was not found on this server.</p>
<p><a href="/%s">back to channel page</a></p>
<p>[tenant] timestamp: %d</p>`, TWITCH_CHANNEL, now)
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "80"
	}
	srv := &http.Server{
		Addr:    ":" + port,
		Handler: router,
	}
	log.Println("Tenant container listening on port", port)
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
	user := getSessionUser(r)
	channels := listChannels(r.Context())
	userBytes, _ := json.Marshal(user)

	data := map[string]any{
		"page_hash":          indexPageHash,
		"user":               string(userBytes),
		"channel":            TWITCH_CHANNEL,
		"channels":           strings.Join(channels, ","),
		"is_super_admin":     isSuperAdmin(user),
		"enabled_cooldown":   ENABLED_COOLDOWN.Milliseconds(),
		"is_chat_fullscreen": false,
		"bgcolor":            "",
	}
	indexTemplate.Execute(w, data)
}

func indexHandlerChat(w http.ResponseWriter, r *http.Request) {
	user := getSessionUser(r)
	channels := listChannels(r.Context())
	userBytes, _ := json.Marshal(user)

	bgcolor := r.URL.Query().Get("bgcolor")
	if bgcolor == "" {
		bgcolor = "transparent"
	}

	data := map[string]any{
		"page_hash":          indexPageHash,
		"user":               string(userBytes),
		"channel":            TWITCH_CHANNEL,
		"channels":           strings.Join(channels, ","),
		"is_super_admin":     isSuperAdmin(user),
		"enabled_cooldown":   ENABLED_COOLDOWN.Milliseconds(),
		"is_chat_fullscreen": true,
		"bgcolor":            bgcolor,
	}
	indexTemplate.Execute(w, data)
}

func wsHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		http.Error(w, "websocket upgrade failed", http.StatusInternalServerError)
		return
	}
	log.Println("[websocket] client connected")

	wsConn := &WSConn{Conn: conn}
	wsClients.Store(wsConn, true)

	// Immediately send the page_hash
	sendJSONWrapped(wsConn, map[string]any{
		"type": "page_hash",
		"content": map[string]any{
			"page_hash": indexPageHash,
		},
	})

	go func() {
		defer func() {
			wsClients.Delete(wsConn)
			conn.Close()
			log.Println("[websocket] client disconnected")
		}()
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				log.Printf("[websocket] read error: %v\n", err)
				return
			}
			log.Printf("[websocket] message: %s\n", msg)
			// could parse incoming messages from the client here if needed.
		}
	}()
}

func wsNumClientsHandler(w http.ResponseWriter, r *http.Request) {
	count := 0
	wsClients.Range(func(key, _ any) bool {
		count++
		return true
	})
	w.Write([]byte(fmt.Sprintf("%d", count)))
}

// -----------------------------------------------------------------------------
//  Status handlers
// -----------------------------------------------------------------------------

// --------------------------------------------------
// Handlers for each /status/* route
// --------------------------------------------------

// /status/twitch
func statusTwitchHandler(w http.ResponseWriter, r *http.Request) {
	data := map[string]interface{}{
		"connected":    twitchConnected,
		"twitchClient": debugInspect(twitchClient),
	}
	respondJSON(w, data)
}

// /status/youtube
func statusYouTubeHandler(w http.ResponseWriter, r *http.Request) {
	data := map[string]interface{}{
		"connected":     youtubeConnected,
		"youtubeCancel": debugInspect(youtubeCancel),
	}
	respondJSON(w, data)
}

// /status/owncast
func statusOwncastHandler(w http.ResponseWriter, r *http.Request) {
	data := map[string]interface{}{
		"connected":   owncastConnected,
		"owncastConn": strings.ReplaceAll(strings.ReplaceAll(debugInspect(owncastConn), "0x0, ", ""), "0x0", "..."),
	}
	respondJSON(w, data)
}

// /status/kick
func statusKickHandler(w http.ResponseWriter, r *http.Request) {
	data := map[string]interface{}{
		"connected":  kickConnected,
		"kickClient": debugInspect(kickClient),
	}
	respondJSON(w, data)
}

// /status/emotes
func statusEmotesHandler(w http.ResponseWriter, r *http.Request) {
	// For example, how many emotes do we have, lastUpdated, etc.
	emotes.EmoteLock.Lock()
	defer emotes.EmoteLock.Unlock()

	data := map[string]interface{}{
		"NumEmotes":       len(emotes.EmoteCache.Emotes),
		"LastUpdated":     emotes.EmoteCache.LastUpdated,
		"StartedUpdating": emotes.EmoteCache.StartedUpdating,
	}
	respondJSON(w, data)
}

func respondJSON(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	if err := enc.Encode(data); err != nil {
		log.Println("respondJSON error:", err)
	}
}

// debugInspect dumps a Go object to string.
func debugInspect(obj interface{}) string {
	return fmt.Sprintf("%#v", obj)
}

// -----------------------------------------------------------------------------
//  Channel/viewer props
// -----------------------------------------------------------------------------

func getChannelPropHandler(w http.ResponseWriter, r *http.Request) {
	propName := mux.Vars(r)["prop_name"]
	val := getChannelProp(r.Context(), propName)
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

	setChannelProp(r.Context(), propName, body.PropValue)
	w.Write([]byte("ok"))
}

func getAllViewersHandler(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	viewers := listViewers(ctx)
	data := make(map[string]map[string]any)
	for _, v := range viewers {
		props, _ := getAllViewerProps(ctx, v)
		data[v] = props
	}
	b, _ := json.Marshal(data)
	w.Header().Set("Content-Type", "application/json")
	w.Write(b)
}

func deleteViewerHandler(w http.ResponseWriter, r *http.Request) {
	username := mux.Vars(r)["username"]
	deleteViewer(r.Context(), username)
	w.Write([]byte("ok"))
}

func getViewerPropHandler(w http.ResponseWriter, r *http.Request) {
	username := mux.Vars(r)["username"]
	propName := mux.Vars(r)["prop_name"]
	val := getViewerProp(r.Context(), username, propName)
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
	if _, ok := DEFAULT_VIEWER_PROPS[propName]; !ok {
		http.Error(w, "invalid prop_name", http.StatusBadRequest)
		return
	}

	setViewerProp(r.Context(), username, propName, body.PropValue)
	w.Write([]byte("ok"))
}

// -----------------------------------------------------------------------------
//  Chat utilities
// -----------------------------------------------------------------------------

func clearChatHandler(w http.ResponseWriter, r *http.Request) {
	clearChat()
	w.Write([]byte("ok"))
}

func chatHistoryHandler(w http.ResponseWriter, r *http.Request) {
	b, _ := json.Marshal(chatHistory)
	w.Header().Set("Content-Type", "application/json")
	w.Write(b)
}

func findYoutubeIDHandler(w http.ResponseWriter, r *http.Request) {
	channel := r.URL.Query().Get("channel")
	log.Println("[youtube] looking up", channel)
	if strings.HasPrefix(channel, "http://www.youtube.com/") || strings.HasPrefix(channel, "http://youtube.com/") {
		channel = strings.Replace(channel, "http://", "", 1)
	}
	if strings.HasPrefix(channel, "www.youtube.com/") || strings.HasPrefix(channel, "youtube.com/") {
		channel = "https://" + channel
	}
	//handle the handle
	if strings.HasPrefix(channel, "@") {
		// https://www.youtube.com/@jjvan
		channel = "https://www.youtube.com/" + channel
	} else if !strings.HasPrefix(channel, "https://") && !strings.HasPrefix(channel, "http://") {
		channel = "https://www.youtube.com/@" + channel
	}
	if strings.HasPrefix(channel, "https://www.youtube.com/channel/") ||
		strings.HasPrefix(channel, "https://youtube.com/channel/") ||
		strings.HasPrefix(channel, "https://www.youtube.com/@") ||
		strings.HasPrefix(channel, "https://youtube.com/@") {

		// Fetch the channel page
		resp, err := http.Get(channel)
		if err != nil {
			log.Println("[youtube] error fetching channel page:", err)
			http.Error(w, "error", http.StatusInternalServerError)
			return
		}
		defer resp.Body.Close()
		// Read the response body
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			log.Println("[youtube] error reading response body:", err)
			http.Error(w, "error", http.StatusInternalServerError)
			return
		}
		// Extract the canonical URL
		re := regexp.MustCompile(`<link rel="canonical" href="https://www\.youtube\.com/channel/([^"]*)">`)
		match := re.FindStringSubmatch(string(body))
		if match != nil {
			channelID := match[1]
			log.Println("[youtube] found ID:", channelID, "for channel:", channel)
			fmt.Fprint(w, channelID)
		} else {
			log.Println("[youtube] error finding channel ID for:", channel)
			http.Error(w, "error", http.StatusInternalServerError)
		}
	} else {
		log.Println("[youtube] invalid URL or handle provided:", channel)
		http.Error(w, "invalid", http.StatusBadRequest)
	}
}

// -----------------------------------------------------------------------------
//  Helpers, data, etc.
// -----------------------------------------------------------------------------

type WSConn struct {
	Conn  *websocket.Conn
	Mutex sync.Mutex
}

func sendJSONWrapped(wsConn *WSConn, data any) {
	wsConn.Mutex.Lock()
	defer wsConn.Mutex.Unlock()
	wsConn.Conn.WriteJSON(data)
}

func broadcast(msgType string, content any) {
	wsClients.Range(func(key, _ any) bool {
		wsConn, ok := key.(*WSConn)
		if !ok {
			return true
		}
		sendJSONWrapped(wsConn, map[string]any{"type": msgType, "content": content})
		return true
	})
}

func sha256sum(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

// small helper to retrieve the current user from the session
func getSessionUser(r *http.Request) *twitchUser {
	session := redisSession.GetSession(r)
	if session == nil {
		return nil
	}
	user, ok := session.Data["twitch_user"].(*twitchUser)
	if !ok {
		return nil
	}
	return user
}

func isSuperAdmin(user *twitchUser) bool {
	if user == nil {
		return false
	}
	return strings.EqualFold(user.Login, TWITCH_SUPER_ADMIN_USERNAME)
}

func channelAuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user := getSessionUser(r)
		if user == nil {
			http.Error(w, "Forbidden (no user in session)", http.StatusForbidden)
			return
		}
		if strings.EqualFold(user.Login, TWITCH_CHANNEL) || isSuperAdmin(user) {
			next.ServeHTTP(w, r)
		} else {
			http.Error(w, "Forbidden (not channel owner or super admin)", http.StatusForbidden)
		}
	})
}

// -----------------------------------------------------------------------------
//  Redis property logic
// -----------------------------------------------------------------------------

func ensureFirstRun() {
	ctx := context.Background()
	didFirstRun := getChannelPropBool(ctx, "did_first_run")
	if !didFirstRun {
		log.Println("FIRST RUN logic: clearing viewer data, channel props, etc.")
		viewerSetKey := redisSession.PREDIS + "channels/" + TWITCH_CHANNEL + "/viewers"
		viewers, _ := redisSession.Rdb.SMembers(ctx, viewerSetKey).Result()
		for _, v := range viewers {
			redisSession.Rdb.Del(ctx, viewerKey(v))
		}
		redisSession.Rdb.Del(ctx, viewerSetKey)
		for propName := range DEFAULT_CHANNEL_PROPS {
			redisSession.Rdb.Del(ctx, channelPropKey(propName))
		}
		setViewerProp(ctx, TWITCH_BOT_USERNAME, "nickname", DEFAULT_BOT_NICKNAME)
		setChannelProp(ctx, "did_first_run", true)
	}
}

func channelPropKey(propName string) string {
	return redisSession.PREDIS + "channels/" + TWITCH_CHANNEL + "/channel_props/" + propName
}

func viewerKey(username string) string {
	return redisSession.PREDIS + "channels/" + TWITCH_CHANNEL + "/viewers/" + username
}

func addChannelPropListener(propName string, fn func(oldValue, newValue interface{})) {
	channelPropListeners[propName] = append(channelPropListeners[propName], fn)
}

func addViewerPropListener(propName string, fn func(username string, oldVal, newVal interface{})) {
	viewerPropListeners[propName] = append(viewerPropListeners[propName], fn)
}

func listChannels(ctx context.Context) []string {
	channels, _ := redisSession.Rdb.SMembers(ctx, redisSession.PREDIS+"channels").Result()
	return channels
}

func listViewers(ctx context.Context) []string {
	viewers, _ := redisSession.Rdb.SMembers(ctx, redisSession.PREDIS+"channels/"+TWITCH_CHANNEL+"/viewers").Result()
	return viewers
}

func getChannelPropBool(ctx context.Context, propName string) bool {
	v := getChannelProp(ctx, propName)
	if v == nil {
		return false
	}
	b, ok := v.(bool)
	if !ok {
		return false
	}
	return b
}
func getChannelPropInt(ctx context.Context, propName string) int {
	v := getChannelProp(ctx, propName)
	if v == nil {
		return 0
	}
	switch t := v.(type) {
	case float64:
		return int(t)
	case int:
		return t
	default:
		return 0
	}
}

func getChannelProp(ctx context.Context, propName string) any {
	val, err := redisSession.Rdb.Get(ctx, channelPropKey(propName)).Result()
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

func setChannelProp(ctx context.Context, propName string, propValue interface{}) {
	// check old value if needed
	var oldVal interface{}
	if listeners, exists := channelPropListeners[propName]; exists && len(listeners) > 0 {
		oldVal = getChannelProp(ctx, propName)
	}

	if propValue == nil {
		redisSession.Rdb.Del(ctx, channelPropKey(propName))
	} else {
		raw, _ := json.Marshal(propValue)
		redisSession.Rdb.Set(ctx, channelPropKey(propName), raw, 0)
	}
	broadcast("channel_prop", map[string]any{
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

func getViewerProp(ctx context.Context, username, propName string) any {
	val, err := redisSession.Rdb.HGet(ctx, viewerKey(username), propName).Result()
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

func getAllViewerProps(ctx context.Context, username string) (map[string]any, error) {
	hash, err := redisSession.Rdb.HGetAll(ctx, viewerKey(username)).Result()
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

func setViewerProp(ctx context.Context, username, propName string, propValue interface{}) {
	var oldVal interface{}
	listeners, hasListeners := viewerPropListeners[propName]
	if hasListeners && len(listeners) > 0 {
		oldVal = getViewerProp(ctx, username, propName)
	}
	if propValue == nil {
		redisSession.Rdb.HDel(ctx, viewerKey(username), propName)
	} else {
		redisSession.Rdb.SAdd(ctx, redisSession.PREDIS+"channels/"+TWITCH_CHANNEL+"/viewers", username)
		raw, _ := json.Marshal(propValue)
		redisSession.Rdb.HSet(ctx, viewerKey(username), propName, string(raw))
	}
	broadcast("viewer_prop", map[string]any{
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

func deleteViewer(ctx context.Context, username string) {
	// If you want to trigger “oldValue => nilValue” for each property:
	props, _ := getAllViewerProps(ctx, username)
	for propName, oldVal := range props {
		if listFns, exists := viewerPropListeners[propName]; exists {
			for _, fn := range listFns {
				fn(username, oldVal, nil)
			}
		}
	}
	redisSession.Rdb.SRem(ctx, redisSession.PREDIS+"channels/"+TWITCH_CHANNEL+"/viewers", username)
	redisSession.Rdb.Del(ctx, viewerKey(username))
	broadcast("delete_viewer", map[string]any{"username": username})
}

// -----------------------------------------------------------------------------
//  Actual bridging logic + greetz, pronouns, emotes
// -----------------------------------------------------------------------------

func clearChat() {
	chatHistory = chatHistory[:0]
	log.Println("CLEAR CHAT")
	broadcast("command", map[string]any{"command": "clear"})
}

// sendChat merges the final step: attach 3rd-party emotes, attach pronouns, broadcast out.
func sendChat(source, username, nickname, color, text string, emotesMap map[string][]string) {
	// find or attach pronouns
	pronouns := getUserPronouns(username)
	if emotesMap == nil {
		emotesMap = make(map[string][]string)
	}
	// also merge any found 3rd-party emotes in the text
	go updateEmoteCacheIfNeeded()
	thirdParty := emotes.Find3rdPartyEmotes(text)
	for url, positions := range thirdParty {
		emotesMap[url] = positions
	}

	msg := ChatMessage{
		Source:   source,
		Username: username,
		Nickname: nickname,
		Pronouns: pronouns,
		Color:    color,
		Emotes:   emotesMap,
		Text:     text,
	}
	chatHistory = append(chatHistory, msg)
	if len(chatHistory) > CHAT_HISTORY_LENGTH {
		chatHistory = chatHistory[1:]
	}
	log.Printf("[websocket] [%s] SEND CHAT %s (nickname: %s pronouns: %s color: %s emotes: %v): %s", source, username, nickname, pronouns, color, emotesMap, text)
	broadcast("chat", msg)
}

// ----------------------------------------------------
//  greetz logic
// ----------------------------------------------------

func greetz(username string, validCommand, shouldReply bool) {
	if strings.EqualFold(username, TWITCH_BOT_USERNAME) {
		return
	}
	// Only greet if the user has a nickname set (like in Node).
	ctx := context.Background()
	nick := getViewerProp(ctx, username, "nickname")
	if nick == nil {
		return
	}

	// Retrieve the last time we saw this user
	lastSeensLock.Lock()
	lastSeen, hasSeen := lastSeens[username]
	nowMs := time.Now().UnixMilli()
	lastSeensLock.Unlock()

	greetzThreshold := int64(getChannelPropInt(ctx, "greetz_threshold"))
	wbThreshold := int64(getChannelPropInt(ctx, "greetz_wb_threshold"))

	if !hasSeen || (nowMs-lastSeen > greetzThreshold) {
		// They’ve been away a long time => use initial greet
		if shouldReply && validCommand {
			// If they typed a valid command, wait 2s, then greet with "also" variant
			go func(u string) {
				time.Sleep(GREETZ_DELAY_FOR_COMMAND)
				sayTwitch(parseGreetz(GREETZ_ALSO, u))
			}(username)
		} else {
			sayTwitch(parseGreetz(GREETZ, username))
		}
	} else if !hasSeen || (nowMs-lastSeen > wbThreshold) {
		// They’ve been away for a shorter threshold => welcome back
		if shouldReply && validCommand {
			go func(u string) {
				time.Sleep(GREETZ_DELAY_FOR_COMMAND)
				sayTwitch(parseGreetz(GREETZ_WELCOME_BACK_ALSO, u))
			}(username)
		} else {
			sayTwitch(parseGreetz(GREETZ_WELCOME_BACK, username))
		}
	}

	// Update lastSeens
	lastSeensLock.Lock()
	lastSeens[username] = nowMs
	lastSeensLock.Unlock()
}

func parseGreetz(stock []string, username string) string {
	ctx := context.Background()
	nickname, _ := getViewerProp(ctx, username, "nickname").(string)
	custom, _ := getViewerProp(ctx, username, "custom_greetz").(string)

	message := ""
	if custom != "" {
		message = custom
	} else {
		message = stock[rand.Intn(len(stock))]
	}
	// In Node code: message.replaceAll('@', '@'+username).replaceAll('#', nickname)
	// Go doesn't have replaceAll in older versions, but we can just do strings.ReplaceAll
	res := strings.ReplaceAll(message, "@", "@"+username)
	res = strings.ReplaceAll(res, "#", nickname)
	return res
}

// ----------------------------------------------------
//  Pronouns logic
// ----------------------------------------------------

func getUserPronouns(username string) string {
	if username == "" {
		return ""
	}
	pronounLock.Lock()
	entry, exists := pronounCache[strings.ToLower(username)]
	pronounLock.Unlock()

	now := time.Now()
	if exists {
		// If our pronoun is still valid, return it
		if entry.LastUpdated.Add(PRONOUN_CACHE_TIME).After(now) {
			return entry.Pronouns
		}
		// else if it’s expired, check if we’re allowed to refresh
		if entry.StartedUpdating.Add(PRONOUN_RETRY_TIME).After(now) {
			// If we tried updating too recently, just return whatever we have
			return entry.Pronouns
		}
		// Otherwise, we’ll go fetch
	} else {
		// Not in the cache => we’ll fetch
		entry = &pronounEntry{}
		pronounLock.Lock()
		pronounCache[strings.ToLower(username)] = entry
		pronounLock.Unlock()
	}

	// Mark that we started updating
	entry.StartedUpdating = now

	go fetchPronouns(username)
	return entry.Pronouns
}

func fetchPronouns(username string) {
	// https://pronouns.alejo.io/api/users/<username> => e.g. [{"id":"501240813","login":"jjvanvan","pronoun_id":"any"}]
	url := fmt.Sprintf("https://pronouns.alejo.io/api/users/%s", strings.ToLower(username))
	resp, err := http.Get(url)
	if err != nil {
		log.Println("[pronouns] fetch error:", err)
		return
	}
	defer resp.Body.Close()
	var arr []struct {
		ID        string `json:"id"`
		Login     string `json:"login"`
		PronounId string `json:"pronoun_id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&arr); err != nil {
		log.Println("[pronouns] decode error:", err)
		return
	}
	var p string
	if len(arr) > 0 && arr[0].PronounId != "" {
		if disp, ok := possiblePronouns[arr[0].PronounId]; ok {
			p = disp
		} else {
			// fallback to raw pronoun_id
			p = arr[0].PronounId
		}
	}

	now := time.Now()
	pronounLock.Lock()
	defer pronounLock.Unlock()
	entry := pronounCache[strings.ToLower(username)]
	if entry == nil {
		entry = &pronounEntry{}
		pronounCache[strings.ToLower(username)] = entry
	}
	entry.Pronouns = p
	entry.LastUpdated = now
	entry.StartedUpdating = time.Time{} // done

	// If you want to broadcast so the front-end can retroactively update pronouns:
	broadcast("pronouns", map[string]any{
		"username": username,
		"pronouns": p,
	})

	// Optionally: also patch chatHistory so older messages get updated pronouns
	for i := range chatHistory {
		if strings.EqualFold(chatHistory[i].Username, username) && chatHistory[i].Pronouns == "" {
			chatHistory[i].Pronouns = p
		}
	}
}

// If you want to build a bigger mapping from pronouns.alejo.io at startup:
func loadPronounMapOnce() {
	url := "https://pronouns.alejo.io/api/pronouns"
	resp, err := http.Get(url)
	if err != nil {
		log.Println("[pronouns] error fetching master pronoun list:", err)
		return
	}
	defer resp.Body.Close()
	var data []struct {
		Name    string `json:"name"`
		Display string `json:"display"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		log.Println("[pronouns] error decoding master pronoun list:", err)
		return
	}
	count := 0
	for _, d := range data {
		possiblePronouns[d.Name] = d.Display
		count++
	}
	log.Printf("[pronouns] fetched pronoun list of length %d\n", count)
}

// -----------------------------------------------------------------------------
//  Emotes logic
// -----------------------------------------------------------------------------

func emoteCacheRefresher() {
	// wait a bit after startup
	time.Sleep(EMOTE_STARTUP_DELAY)
	for {
		updateEmoteCacheIfNeeded()
		time.Sleep(EMOTE_CACHE_TIME)
	}
}

func updateEmoteCacheIfNeeded() {
	emotes.EmoteLock.Lock()
	defer emotes.EmoteLock.Unlock()

	now := time.Now()
	log.Println(now, "|", emotes.EmoteCache.LastUpdated, "|", EMOTE_CACHE_TIME, "|", emotes.EmoteCache.StartedUpdating, "|", EMOTE_RETRY_TIME)
	if !emotes.EmoteCache.LastUpdated.IsZero() && now.Before(emotes.EmoteCache.LastUpdated.Add(EMOTE_CACHE_TIME)) {
		log.Println("[emotes] 3rd-party emote cache already updated")
		return
	}

	if !emotes.EmoteCache.StartedUpdating.IsZero() && now.Before(emotes.EmoteCache.StartedUpdating.Add(EMOTE_RETRY_TIME)) {
		log.Println("[emotes] emote cache update in progress, skipping")
		return
	}

	log.Println("[emotes] updating 3rd-party emote cache")
	emotes.EmoteCache.StartedUpdating = now

	globalMap, errGlob := emotes.FetchAllGlobalEmotes()
	if errGlob != nil {
		log.Println("some global fetch error:", errGlob)
	}

	newMap := make(map[string]string)
	for code, url := range globalMap {
		newMap[code] = url
	}

	channelID, err := twitchApi.GetTwitchChannelID(TWITCH_CHANNEL, TWITCH_CLIENT_ID, TWITCH_SECRET)
	if err != nil {
		log.Println("[emotes] Error getting channel ID:", err)
	} else {
		log.Printf("[emotes] Channel %s has ID=%d\n", TWITCH_CHANNEL, channelID)
		channelMap, errChan := emotes.FetchAllChannelEmotes(channelID)
		if errChan != nil {
			log.Println("[emotes] some channel fetch error:", errChan)
		}
		for code, url := range channelMap {
			newMap[code] = url
		}
	}

	// Save into your main cache
	emotes.EmoteCache.Emotes = newMap
	emotes.EmoteCache.LastUpdated = now
	emotes.EmoteCache.StartedUpdating = time.Time{}

	log.Println("[emotes] done updating 3rd-party emote cache")
}

// -----------------------------------------------------------------------------
//  Twitch bridging
// -----------------------------------------------------------------------------

func connectToTwitchLoop() {
	for {
		ctx := context.Background()
		if getChannelPropBool(ctx, "enabled") && !twitchConnected {
			connectToTwitch()
		}
		time.Sleep(1 * time.Minute)
	}
}

func connectToTwitch() {
	if !getChannelPropBool(context.Background(), "enabled") {
		log.Println("[twitch] bot is disabled, will not connect")
		return
	}
	log.Printf("[twitch] connecting as %s to channel %s\n", TWITCH_BOT_USERNAME, TWITCH_CHANNEL)
	twitchClient = twitch.NewClient(TWITCH_BOT_USERNAME, TWITCH_BOT_OAUTH_TOKEN)
	// Callback for normal chat messages
	twitchClient.OnPrivateMessage(func(msg twitch.PrivateMessage) {
		// Ignore our own bot messages
		if strings.EqualFold(msg.User.Name, TWITCH_BOT_USERNAME) {
			return
		}
		// Ignore whispers or messages from other channels
		if !strings.EqualFold(msg.Channel, TWITCH_CHANNEL) {
			return
		}

		ctx := context.Background()
		username := msg.User.DisplayName
		if username == "" {
			username = msg.User.Name
		}
		nickname, _ := getViewerProp(ctx, username, "nickname").(string)

		color := msg.User.Color

		// Build an "emotes" map from the official Twitch emotes
		emoteMap := make(map[string][]string)

		for _, emotePtr := range msg.Emotes {
			if emotePtr == nil {
				continue
			}
			emoteKey := emotePtr.ID // e.g. "25", "1902", etc.

			// Each Emote can have multiple Positions
			for _, pos := range emotePtr.Positions {
				// e.g. "3-7"
				emoteRange := fmt.Sprintf("%d-%d", pos.Start, pos.End)
				emoteMap[emoteKey] = append(emoteMap[emoteKey], emoteRange)
			}
		}

		// 3rd-party emotes (BTTV, 7TV, FFZ, :colon: style), found via find3rdPartyEmotes
		// thirdParty := find3rdPartyEmotes(msg.Message)
		// for url, positions := range thirdParty {
		//     emoteMap[url] = append(emoteMap[url], positions...)
		// }

		// Now send the chat with combined emotes
		sendChat("twitch", username, nickname, color, msg.Message, emoteMap)

		// Check commands & greet
		validCommand, shouldReply := handleCommand(msg, username)
		greetz(username, validCommand, shouldReply)
	})

	// Other handlers...
	twitchClient.OnWhisperMessage(func(msg twitch.WhisperMessage) {
		// ...
	})
	twitchClient.OnConnect(func() {
		log.Println("[twitch] connected!")
		twitchClient.Join(TWITCH_CHANNEL)
		twitchConnected = true
	})

	go func() {
		if err := twitchClient.Connect(); err != nil {
			log.Println("[twitch] connect error:", err)
			twitchConnected = false
		}
	}()
}

func sayTwitch(message string) {
	if twitchClient == nil || !twitchConnected {
		return
	}
	twitchClient.Say(TWITCH_CHANNEL, message)

	nickname, _ := getViewerProp(context.Background(), TWITCH_BOT_USERNAME, "nickname").(string)
	sendChat("twitch", TWITCH_BOT_USERNAME, nickname, "", message, nil)
}

func disconnectFromTwitch() {
	if twitchClient != nil && twitchConnected {
		log.Println("[twitch] disconnecting")
		twitchClient.Disconnect()
		twitchConnected = false
		twitchClient = nil
	}
}

func handleCommand(msg twitch.PrivateMessage, username string) (bool, bool) {
	command := strings.ReplaceAll(msg.Message, " 󠀀", " ")
	command = strings.TrimSpace(command)
	validCommand := true
	shouldReply := true

	switch {
	case command == "!help" || command == "!commands":
		sayTwitch(`commands: !nick - set your nickname; !botpage - link to the page with nicknames and other info; !multichat - link to combined chat; !clear - clear the multichat`)
	case command == "!botpage":
		sayTwitch(fmt.Sprintf("see the nicknames and other bot info at %s/%s", BASE_URL, TWITCH_CHANNEL))
	case command == "!multichat":
		sayTwitch(fmt.Sprintf("see the multichat at %s/%s/chat (change font and show/hide options on !botpage)", BASE_URL, TWITCH_CHANNEL))
	case command == "!clear":
		// Only allow if user is mod, broadcaster, or super admin
		if msg.User.IsMod || strings.EqualFold(msg.User.Name, TWITCH_CHANNEL) || strings.EqualFold(msg.User.Name, TWITCH_SUPER_ADMIN_USERNAME) {
			clearChat()
			shouldReply = false
		} else {
			sayTwitch(fmt.Sprintf("@%s you do not have permission to clear chat", username))
		}
	case command == "!nick":
		ctx := context.Background()
		curr := getViewerProp(ctx, username, "nickname")
		if curr != nil {
			setViewerProp(ctx, username, "nickname", nil)
			sayTwitch(fmt.Sprintf("@%s removed nickname, sad to see you go", username))
		} else {
			sayTwitch(fmt.Sprintf("@%s please provide a nickname, e.g. !nick name", username))
		}
	case strings.HasPrefix(command, "!nick "):
		ctx := context.Background()
		parts := strings.SplitN(command, " ", 2)
		if len(parts) < 2 {
			sayTwitch(fmt.Sprintf("@%s please provide a nickname after !nick", username))
			break
		}
		nickname := strings.TrimSpace(parts[1])
		maxLen := getChannelPropInt(ctx, "max_nickname_length")

		if goaway.IsProfane(nickname) {
			sayTwitch(fmt.Sprintf("@%s no profanity allowed in nickname, choose a different one", username))
		} else if getViewerProp(ctx, username, "nickname") == nickname {
			sayTwitch(fmt.Sprintf("@%s you already have that nickname", username))
		} else if len(nickname) > maxLen {
			sayTwitch(fmt.Sprintf("@%s nickname \"%s\" is too long, max length = %d", username, nickname, maxLen))
		} else if isNicknameTaken(nickname) {
			sayTwitch(fmt.Sprintf("@%s nickname \"%s\" is already taken, see !botpage for the list", username, nickname))
		} else {
			setViewerProp(ctx, username, "nickname", nickname)
			sayTwitch(fmt.Sprintf("@%s set nickname to %s", username, nickname))
		}
	default:
		validCommand = false
	}
	return validCommand, shouldReply
}

// isNicknameTaken checks if any other user is using the given nickname
func isNicknameTaken(nick string) bool {
	ctx := context.Background()
	viewers := listViewers(ctx)
	for _, v := range viewers {
		val := getViewerProp(ctx, v, "nickname")
		if valStr, ok := val.(string); ok && valStr == nick {
			return true
		}
	}
	return false
}

// -----------------------------------------------------------------------------
//  YouTube bridging
// -----------------------------------------------------------------------------

func connectToYouTubeLoop() {
	for {
		ctx := context.Background()
		if getChannelPropBool(ctx, "enabled") && !youtubeConnected {
			connectToYouTube()
		}
		time.Sleep(YOUTUBE_CHECK_INTERVAL)
	}
}

func connectToYouTube() {
	if !getChannelPropBool(context.Background(), "enabled") {
		log.Println("[youtube] bot is disabled, will not connect")
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	youtubeCancel = cancel
	youtubeConnected = true

	youtubeChannelID, ok := getChannelProp(context.Background(), "youtube_id").(string)
	if !ok || youtubeChannelID == "" {
		log.Println("[youtube] no youtube_id set, skipping connect")
		youtubeConnected = false
		return
	}

	// Build a URL for the channel's live stream
	liveURL := fmt.Sprintf("https://www.youtube.com/channel/%s/live", youtubeChannelID)
	log.Println("[youtube] connecting to", liveURL)

	continuation, cfg, err := YtChat.ParseInitialData(liveURL)
	if err != nil {
		log.Println("[youtube] parse error:", err)
		youtubeConnected = false
		return
	}
	youtubeWG.Add(1)
	go func() {
		defer youtubeWG.Done()
		defer func() {
			youtubeConnected = false
			log.Println("[youtube] disconnected")
			sayTwitch("disconnected from youtube chat")
		}()
		log.Println("[youtube] connected")
		videoID, err := getYoutubeLiveVideoID(youtubeChannelID)
		if err != nil {
			log.Printf("[youtube] %s failed to find livestream: %v", youtubeChannelID, err)
		} else {
			log.Printf("[youtube] %s connected to youtube chat: youtu.be/%s", youtubeChannelID, videoID)
			//delay the message a bit to allow the disconnect message to come thru first
			go func() {
				time.Sleep(TWITCH_MESSAGE_DELAY)
				sayTwitch("connected to youtube chat: youtu.be/" + videoID)
			}()
		}

		for {
			select {
			case <-ctx.Done():
				log.Println("[youtube] canceled")
				return
			default:
			}

			log.Println("[youtube] Fetching chat messages...")

			chat, newCont, err := YtChat.FetchContinuationChat(continuation, cfg)
			if err == YtChat.ErrLiveStreamOver {
				log.Println("[youtube] stream over")
				return
			}
			if err != nil {
				log.Println("[youtube] fetch error:", err)
				time.Sleep(5 * time.Second)
				continue
			}
			log.Printf("[youtube] Retrieved %d messages\n", len(chat))

			continuation = newCont
			now := time.Now()
			for _, msg := range chat {
				log.Printf("[youtube] Processing message: %+v\n", msg)
				if !youtubeConnected {
					log.Println("[youtube] got message while not connected:", msg)
					continue
				}
				if msg.Message == "" {
					log.Println("[youtube] Skipping empty message")
					continue
				}
				if now.Sub(msg.Timestamp) > YOUTUBE_MAX_MESSAGE_AGE {
					log.Println("[youtube] Skipping old message")
					continue
				}
				log.Printf("[youtube] %s: %s\n", msg.AuthorName, msg.Message)
				sendChat("youtube", msg.AuthorName, "", "", msg.Message, nil)

				// Forward specific commands from YouTube to Twitch
				fwdCmds := getChannelProp(context.Background(), "fwd_cmds_yt_twitch").([]string)
				for _, cmdStr := range fwdCmds {
					if strings.HasPrefix(msg.Message, cmdStr) {
						log.Println("[youtube] Forwarding command to Twitch:", msg.Message)
						sayTwitch(goaway.Censor(msg.Message))
					}
				}
			}
			time.Sleep(2 * time.Second)
		}
	}()
}

func disconnectFromYouTube() {
	if youtubeConnected {
		log.Println("[youtube] disconnecting")
		if youtubeCancel != nil {
			youtubeCancel()
		}
		youtubeWG.Wait()
		youtubeConnected = false
	}
}

// getYtInitialData fetches and extracts ytInitialData JSON
func getYtInitialData(youtubeID string, subURL string) (map[string]interface{}, error) {
	url := fmt.Sprintf("https://www.youtube.com/channel/%s/%s", youtubeID, subURL)
	resp, err := http.Get(url)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch YouTube page: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	// Extract ytInitialData JSON from JavaScript
	re := regexp.MustCompile(`var ytInitialData = ({.*?});`)
	matches := re.FindStringSubmatch(string(body))
	if len(matches) < 2 {
		return nil, fmt.Errorf("ytInitialData not found")
	}

	// Parse JSON
	var data map[string]interface{}
	err = json.Unmarshal([]byte(matches[1]), &data)
	if err != nil {
		return nil, fmt.Errorf("failed to parse ytInitialData JSON: %w", err)
	}

	return data, nil
}

// getYoutubeLiveVideoIDs finds live stream video IDs
func getYoutubeLiveVideoIDs(youtubeID string) ([]string, error) {
	data, err := getYtInitialData(youtubeID, "streams")
	if err != nil {
		return nil, err
	}

	var liveVids []string
	// Recursively search for "videoRenderer" keys
	searchAllJSON(data, "videoRenderer", func(videoData map[string]interface{}) {
		if overlays, found := videoData["thumbnailOverlays"].([]interface{}); found {
			for _, overlay := range overlays {
				overlayMap, ok := overlay.(map[string]interface{})
				if !ok {
					continue
				}
				if renderer, ok := overlayMap["thumbnailOverlayTimeStatusRenderer"].(map[string]interface{}); ok {
					if style, ok := renderer["style"].(string); ok && style == "LIVE" {
						if videoID, found := videoData["videoId"].(string); found {
							liveVids = append(liveVids, videoID)
						}
					}
				}
			}
		}
	})

	return liveVids, nil
}

// getYoutubeLiveVideoID returns the first live video ID
func getYoutubeLiveVideoID(youtubeID string) (string, error) {
	liveVids, err := getYoutubeLiveVideoIDs(youtubeID)
	if err != nil || len(liveVids) == 0 {
		return "", fmt.Errorf("no live video found")
	}
	return liveVids[0], nil
}

// searchAllJSON recursively searches for a key in JSON and calls the callback on found entries
func searchAllJSON(data interface{}, key string, callback func(map[string]interface{})) {
	switch v := data.(type) {
	case map[string]interface{}:
		for k, val := range v {
			if k == key {
				if obj, ok := val.(map[string]interface{}); ok {
					callback(obj)
				}
			}
			searchAllJSON(val, key, callback)
		}
	case []interface{}:
		for _, item := range v {
			searchAllJSON(item, key, callback)
		}
	}
}

// -----------------------------------------------------------------------------
//  Owncast bridging
// -----------------------------------------------------------------------------

func connectToOwncastLoop() {
	for {
		ctx := context.Background()
		if getChannelPropBool(ctx, "enabled") && !owncastConnected {
			connectToOwncast()
		}
		time.Sleep(OWNCAST_CHECK_INTERVAL)
	}
}

func connectToOwncast() {
	if !getChannelPropBool(context.Background(), "enabled") {
		log.Println("[owncast] bot is disabled, will not connect")
		return
	}
	ocURLRaw := getChannelProp(context.Background(), "owncast_url")
	owncastURL, _ := ocURLRaw.(string)
	if owncastURL == "" {
		log.Println("[owncast] no owncast_url, skipping connect")
		return
	}
	regBody := map[string]any{"displayName": DEFAULT_BOT_NICKNAME}
	regBytes, _ := json.Marshal(regBody)
	apiURL := "https://" + owncastURL + "/api/chat/register"
	resp, err := http.Post(apiURL, "application/json", strings.NewReader(string(regBytes)))
	if err != nil {
		log.Println("[owncast] register error:", err)
		return
	}
	defer resp.Body.Close()
	var reg map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&reg); err != nil {
		log.Println("[owncast] register decode error:", err)
		return
	}
	token, _ := reg["accessToken"].(string)
	if token == "" {
		log.Println("[owncast] no accessToken returned")
		return
	}
	log.Printf("[owncast] status: %d, token: %s\n", resp.StatusCode, token)
	wsURL := fmt.Sprintf("wss://%s/ws?accessToken=%s", owncastURL, token)
	c, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		log.Println("[owncast] ws connect error:", err)
		return
	}
	owncastConn = c
	owncastConnected = true
	log.Println("[owncast] connected to", wsURL)
	//delay the message a bit to allow the disconnect message to come thru first
	go func() {
		time.Sleep(TWITCH_MESSAGE_DELAY)
		sayTwitch("connected to owncast chat: https://" + owncastURL)
	}()

	go func() {
		defer disconnectFromOwncast()
		for {
			_, messageBytes, err := c.ReadMessage()
			if err != nil {
				log.Println("[owncast] read error:", err)
				return
			}
			lines := strings.Split(string(messageBytes), "\n")
			for _, line := range lines {
				if line == "" {
					continue
				}
				var msg map[string]any
				if err := json.Unmarshal([]byte(line), &msg); err != nil {
					log.Println("[owncast] parse err:", err)
					continue
				}
				parseOwncastMessage(msg)
			}
		}
	}()
}

func parseOwncastMessage(m map[string]any) {
	t, _ := m["type"].(string)
	body, _ := m["body"].(string)
	userRaw, _ := m["user"].(map[string]any)
	if body == "" || userRaw == nil {
		return
	}
	dispName, _ := userRaw["displayName"].(string)
	if dispName == "" {
		return
	}
	color := "rgb(255,255,255)"
	if val, ok := userRaw["displayColor"].(float64); ok {
		color = fmt.Sprintf("hsla(%d, 100%%, 60%%, 0.85)", int(val))
	}
	if t != "CHAT" {
		body = strings.ReplaceAll(body, "<p>", "")
		body = strings.ReplaceAll(body, "</p>", "")
		body = strings.ReplaceAll(body, "\n", " ")
	}
	if t == "FEDIVERSE_ENGAGEMENT_LIKE" {
		title, _ := m["title"].(string)
		image, _ := m["image"].(string)
		body = fmt.Sprintf("%s %s %s", title, image, body)
		if image != "" {
			start := strings.Index(body, image)
			end := start + len(image) - 1
			emotes := map[string][]string{
				image: {fmt.Sprintf("%d-%d", start, end)},
			}
			sendChat("owncast", dispName, "", color, body, emotes)
			return
		}
	}
	sendChat("owncast", dispName, "", color, body, nil)
}

func disconnectFromOwncast() {
	owncastCloseMu.Lock()
	defer owncastCloseMu.Unlock()
	if owncastConnected && owncastConn != nil {
		log.Println("[owncast] disconnecting")
		owncastConn.Close()
		owncastConn = nil
		owncastConnected = false
		sayTwitch("disconnected from owncast chat")
	}
}

// -----------------------------------------------------------------------------
//  Kick bridging
// -----------------------------------------------------------------------------

func connectToKickLoop() {
	for {
		ctx := context.Background()
		if getChannelPropBool(ctx, "enabled") && !kickConnected {
			connectToKick()
		}
		time.Sleep(KICK_CHECK_INTERVAL)
	}
}

func connectToKick() {
	if !getChannelPropBool(context.Background(), "enabled") {
		log.Println("[kick] bot is disabled, will not connect")
		return
	}
	kcRaw := getChannelProp(context.Background(), "kick_chatroom_id")
	kickChatroomID, _ := kcRaw.(string)
	if kickChatroomID == "" {
		log.Println("[kick] no chatroom ID, skipping connect")
		return
	}
	log.Println("[kick] connecting...")

	c, err := kickchatwrapper.NewClient()
	if err != nil {
		log.Println("[kick] new client error:", err)
		return
	}
	channelID, err := parseChannelID(kickChatroomID)
	if err != nil {
		log.Println("[kick] invalid chatroom ID:", err)
		return
	}
	err = c.JoinChannelByID(channelID)
	if err != nil {
		log.Println("[kick] join error:", err)
		return
	}
	msgChan := c.ListenForMessages()
	kickClient = c
	kickConnected = true
	log.Println("[kick] connected to chatroom ID", channelID)

	go func() {
		defer disconnectFromKick()
		for m := range msgChan {
			if !kickConnected {
				log.Println("[kick] got message while not connected:", m)
				continue
			}
			// m.Sender.Username, m.Content, m.Sender.Identity.Color, etc.
			if m.Sender.Username == "" {
				continue
			}
			sendChat("kick", m.Sender.Username, "", m.Sender.Identity.Color, m.Content, nil)
		}
	}()
}

func parseChannelID(s string) (int, error) {
	var id int
	_, err := fmt.Sscanf(s, "%d", &id)
	return id, err
}

func disconnectFromKick() {
	if kickConnected && kickClient != nil {
		log.Println("[kick] disconnecting")

		// Create a channel to signal when done
		done := make(chan struct{})

		// Attempt to close in a goroutine
		go func() {
			kickClient.Close()
			close(done)
		}()

		// Wait for close or timeout
		select {
		case <-done:
			log.Println("[kick] disconnected successfully")
		case <-time.After(5 * time.Second): // Timeout duration
			log.Println("[kick] disconnect timeout, forcing disconnect")
		}

		// Ensure cleanup
		kickClient = nil
		kickConnected = false
	}
}
