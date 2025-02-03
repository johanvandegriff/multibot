package multiChat

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"multibot/common/env"
	"multibot/tenant-container/src/emotes"
	"multibot/tenant-container/src/frontend"
)

const (
	PRONOUN_CACHE_TIME = 24 * time.Hour
	PRONOUN_RETRY_TIME = 30 * time.Second
)

var (
	wsUpgrader = websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		CheckOrigin:     func(r *http.Request) bool { return true },
	}
	wsClients   sync.Map // map[*WSConn]bool
	chatHistory = make([]ChatMessage, 0, env.CHAT_HISTORY_LENGTH)

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

type ChatMessage struct {
	Source   string              `json:"source"`
	Username string              `json:"username"`
	Nickname string              `json:"nickname"`
	Pronouns string              `json:"pronouns"`
	Color    string              `json:"color"`
	Emotes   map[string][]string `json:"emotes"`
	Text     string              `json:"text"`
}

type WSConn struct {
	Conn  *websocket.Conn
	Mutex sync.Mutex
}

func WsHandler(w http.ResponseWriter, r *http.Request) {
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
			"page_hash": frontend.IndexPageHash,
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

func WsNumClientsHandler(w http.ResponseWriter, r *http.Request) {
	count := 0
	wsClients.Range(func(key, _ any) bool {
		count++
		return true
	})
	w.Write([]byte(fmt.Sprintf("%d", count)))
}

func sendJSONWrapped(wsConn *WSConn, data any) {
	wsConn.Mutex.Lock()
	defer wsConn.Mutex.Unlock()
	wsConn.Conn.WriteJSON(data)
}

func Broadcast(msgType string, content any) {
	wsClients.Range(func(key, _ any) bool {
		wsConn, ok := key.(*WSConn)
		if !ok {
			return true
		}
		sendJSONWrapped(wsConn, map[string]any{"type": msgType, "content": content})
		return true
	})
}

func ClearChat() {
	chatHistory = chatHistory[:0]
	log.Println("CLEAR CHAT")
	Broadcast("command", map[string]any{"command": "clear"})
}

// attach 3rd-party emotes, attach pronouns, broadcast out
func SendChat(source, username, nickname, color, text string, emotesMap map[string][]string) {
	// find or attach pronouns
	pronouns := getUserPronouns(username)
	if emotesMap == nil {
		emotesMap = make(map[string][]string)
	}
	// also merge any found 3rd-party emotes in the text
	go emotes.UpdateEmoteCacheIfNeeded()
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
	if len(chatHistory) > env.CHAT_HISTORY_LENGTH {
		chatHistory = chatHistory[1:]
	}
	log.Printf("[websocket] [%s] SEND CHAT %s (nickname: %s pronouns: %s color: %s emotes: %v): %s", source, username, nickname, pronouns, color, emotesMap, text)
	Broadcast("chat", msg)
}

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
	Broadcast("pronouns", map[string]any{
		"username": username,
		"pronouns": p,
	})

	UpdateChatHistoryPronouns(username, p)
}

// If you want to build a bigger mapping from pronouns.alejo.io at startup:
func LoadPronounMapOnce() {
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

func UpdateChatHistoryNickname(username string, nickname string) {
	for i, msg := range chatHistory {
		if msg.Username == username {
			chatHistory[i].Nickname = nickname
		}
	}
}

func UpdateChatHistoryPronouns(username string, pronouns string) {
	for i, msg := range chatHistory {
		if msg.Username == username {
			chatHistory[i].Pronouns = pronouns
		}
	}
}

func GetChatHistoryJSON() []byte {
	b, _ := json.Marshal(chatHistory)
	return b
}
