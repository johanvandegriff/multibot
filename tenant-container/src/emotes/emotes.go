package emotes

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"multibot/common/src/env"

	"multibot/tenant-container/src/twitchApi"
)

const (
	EMOTE_STARTUP_DELAY = 2 * time.Minute
	EMOTE_CACHE_TIME    = 1 * time.Hour
	EMOTE_RETRY_TIME    = 30 * time.Second
)

var (
	emoteCache = &emoteCacheData{
		Emotes:          make(map[string]string),
		LastUpdated:     time.Time{},
		StartedUpdating: time.Time{},
	}
	emoteLock     sync.Mutex
	youtubeEmotes = make(map[string]string) // Maps `:emote_code:` -> Emote URL
)

type YoutubeEmote struct {
	ID   string `json:"id"`
	Code string `json:"code"`
}

type emoteCacheData struct {
	Emotes          map[string]string // code => URL
	Connections     map[string]bool   // e.g., "global_bttv" => true
	LastUpdated     time.Time
	StartedUpdating time.Time
}

func twitchCDN(id string, size int) string {
	// size=0 => "1.0", size=1 => "2.0", etc.
	return fmt.Sprintf("https://static-cdn.jtvnw.net/emoticons/v2/%s/default/dark/%d.0", id, size+1)
}
func bttvGlobalEndpoint() string { return "https://api.betterttv.net/3/cached/emotes/global" }
func bttvChannelEndpoint(twitchUserID int) string {
	return fmt.Sprintf("https://api.betterttv.net/3/cached/users/twitch/%d", twitchUserID)
}
func bttvCDN(id string, size int) string {
	// size=0 => "1x", size=1 => "2x", etc.
	return fmt.Sprintf("https://cdn.betterttv.net/emote/%s/%dx.webp", id, size+1)
}
func sevenTVGlobalEndpoint() string { return "https://7tv.io/v3/emote-sets/global" }
func sevenTVChannelEndpoint(twitchUserID int) string {
	return fmt.Sprintf("https://7tv.io/v3/users/twitch/%d", twitchUserID)
}
func sevenTVCDN(id string, size string) string {
	// size might be "1x.webp", "2x.webp", "3x.webp" etc.
	return fmt.Sprintf("https://cdn.7tv.app/emote/%s/%s", id, size)
}
func ffzSetEndpoint(setID int) string {
	return fmt.Sprintf("https://api.frankerfacez.com/v1/set/%d", setID)
}
func ffzChannelEndpoint(twitchUserID int) string {
	return fmt.Sprintf("https://api.frankerfacez.com/v1/room/id/%d", twitchUserID)
}
func ffzCDN(id string, size int) string {
	// size=1 => ".../1", size=2 => ".../2", etc.
	return fmt.Sprintf("https://cdn.frankerfacez.com/emote/%s/%d", id, size)
}
func ffzCDNAnimated(id string, size int) string {
	return fmt.Sprintf("https://cdn.frankerfacez.com/emote/%s/animated/%d.webp", id, size)
}

// -----------------------------------
// BTTV
// -----------------------------------
type bttvEmote struct {
	ID        string `json:"id"`
	Code      string `json:"code"`
	ImageType string `json:"imageType"`
}

type bttvChannelResponse struct {
	ChannelEmotes []bttvEmote `json:"channelEmotes"`
	SharedEmotes  []bttvEmote `json:"sharedEmotes"`
}

// -----------------------------------
// 7TV
// -----------------------------------

// The /v3/emote-sets/global returns something like:
// { "id": "global", "emotes": [ { "id": "xxxxx", "name": "peepoClap" }, ... ] ... }
type sevenTVGlobalSet struct {
	ID     string         `json:"id"`
	Name   string         `json:"name"`
	Emotes []sevenTVEmote `json:"emotes"`
}
type sevenTVEmote struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// The /v3/users/twitch/<id> returns { "emote_set": { "emotes": [ ... ] } }
type sevenTVUserResponse struct {
	EmoteSet struct {
		Emotes []sevenTVEmote `json:"emotes"`
	} `json:"emote_set"`
}

// -----------------------------------
// FFZ
// -----------------------------------
type ffzSetResponse struct {
	Sets map[string]struct {
		Emoticons []ffzEmote `json:"emoticons"`
	} `json:"sets"`
}
type ffzEmote struct {
	ID       int               `json:"id"`
	Name     string            `json:"name"`
	Animated bool              `json:"animated"`
	URLs     map[string]string `json:"urls"`
}

// Fetch global BTTV emotes
func fetchBTTVGlobal() (map[string]string, error) {
	out := make(map[string]string)
	resp, err := http.Get(bttvGlobalEndpoint())
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()

	var emotes []bttvEmote
	if err := json.NewDecoder(resp.Body).Decode(&emotes); err != nil {
		return out, err
	}
	// map code => CDN URL (size=2 => "3x.webp" if you want bigger)
	for _, e := range emotes {
		out[e.Code] = bttvCDN(e.ID, 2) // 2 => "3x"
	}
	return out, nil
}

// Fetch channel BTTV emotes by numeric Twitch userID
func fetchBTTVChannel(twitchUserID int) (map[string]string, error) {
	out := make(map[string]string)
	url := bttvChannelEndpoint(twitchUserID)
	resp, err := http.Get(url)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return out, fmt.Errorf("bttv channel error: status %d", resp.StatusCode)
	}

	var data bttvChannelResponse
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return out, err
	}
	// Combine channelEmotes + sharedEmotes
	for _, e := range data.ChannelEmotes {
		out[e.Code] = bttvCDN(e.ID, 2)
	}
	for _, e := range data.SharedEmotes {
		out[e.Code] = bttvCDN(e.ID, 2)
	}
	return out, nil
}

// Fetch 7TV global emotes
func fetch7TVGlobal() (map[string]string, error) {
	out := make(map[string]string)
	resp, err := http.Get(sevenTVGlobalEndpoint())
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return out, fmt.Errorf("7tv global error: status %d", resp.StatusCode)
	}

	var data sevenTVGlobalSet
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return out, err
	}
	// data.Emotes => each has ID, Name
	for _, e := range data.Emotes {
		// pick "2x.webp" for bigger, or "3x.webp" if you prefer
		out[e.Name] = sevenTVCDN(e.ID, "3x.webp")
	}
	return out, nil
}

// Fetch 7TV channel emotes
func fetch7TVChannel(twitchUserID int) (map[string]string, error) {
	out := make(map[string]string)
	url := sevenTVChannelEndpoint(twitchUserID)
	resp, err := http.Get(url)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return out, fmt.Errorf("7tv channel error: status %d", resp.StatusCode)
	}

	var userData sevenTVUserResponse
	if err := json.NewDecoder(resp.Body).Decode(&userData); err != nil {
		return out, err
	}
	for _, e := range userData.EmoteSet.Emotes {
		out[e.Name] = sevenTVCDN(e.ID, "3x.webp")
	}
	return out, nil
}

// For FFZ "global sets", you can fetch set 3 or others from your Node snippet.
// Or you can fetch them from the "v1/set/global" route.
// But let's do set=3 (the "main" global set).
func fetchFFZGlobal() (map[string]string, error) {
	out := make(map[string]string)
	const globalSetID = 3
	url := ffzSetEndpoint(globalSetID)
	resp, err := http.Get(url)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return out, fmt.Errorf("ffz global error: status %d", resp.StatusCode)
	}

	var data ffzSetResponse
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return out, err
	}

	// data.Sets => typically one set with key "3"
	for _, setData := range data.Sets {
		for _, e := range setData.Emoticons {
			if e.Animated {
				// we can pick size=2 for bigger
				out[e.Name] = ffzCDNAnimated(strconv.Itoa(e.ID), 2)
			} else {
				out[e.Name] = ffzCDN(strconv.Itoa(e.ID), 2)
			}
		}
	}
	return out, nil
}

// Fetch channel-specific FFZ emotes
func fetchFFZChannel(twitchUserID int) (map[string]string, error) {
	out := make(map[string]string)
	url := ffzChannelEndpoint(twitchUserID)
	resp, err := http.Get(url)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return out, fmt.Errorf("ffz channel error: status %d", resp.StatusCode)
	}

	var data ffzSetResponse
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return out, err
	}

	for _, setData := range data.Sets {
		for _, e := range setData.Emoticons {
			if e.Animated {
				out[e.Name] = ffzCDNAnimated(strconv.Itoa(e.ID), 2)
			} else {
				out[e.Name] = ffzCDN(strconv.Itoa(e.ID), 2)
			}
		}
	}
	return out, nil
}

// Load YouTube emotes from a local JSON file
func getYouTubeEmotes() map[string]string {
	if len(youtubeEmotes) > 0 {
		log.Printf("[youtube] %d emotes already loaded, skipping", len(youtubeEmotes))
		return youtubeEmotes
	}
	filename := "yt.json"
	data, err := os.ReadFile(filename)
	if err != nil {
		log.Printf("[youtube] error reading %s: %v", filename, err)
		return nil
	}

	var emotes []YoutubeEmote
	if err := json.Unmarshal(data, &emotes); err != nil {
		log.Printf("[youtube] error parsing %s: %v", filename, err)
		return nil
	}

	newEmoteMap := make(map[string]string)
	for _, e := range emotes {
		newEmoteMap[e.Code] = e.ID
	}

	youtubeEmotes = newEmoteMap
	log.Printf("[youtube] loaded %d emotes", len(youtubeEmotes))
	return youtubeEmotes
}

// find3rdPartyEmotes scans the user’s raw text for codes that match the known emotes from our cache
// and returns a map[url] => []ranges, same as the Node version does.
func Find3rdPartyEmotes(msg string) map[string][]string {
	youtubeEmotes := getYouTubeEmotes()

	emotes := make(map[string][]string)
	emoteLock.Lock()
	defer emoteLock.Unlock()

	words := strings.Fields(msg)
	pos := 0
	for _, w := range words {
		if url, ok := emoteCache.Emotes[w]; ok {
			start := pos
			end := pos + len(w) - 1
			emotes[url] = append(emotes[url], fmt.Sprintf("%d-%d", start, end))
		}
		pos += len(w) + 1
	}

	// Match YouTube ":something:" style emotes that might not be space-separated
	re := regexp.MustCompile(`:[a-zA-Z\-]+:`)
	matches := re.FindAllStringIndex(msg, -1)

	for _, match := range matches {
		emoteCode := msg[match[0]:match[1]]
		if url, exists := youtubeEmotes[emoteCode]; exists {
			if _, found := emotes[url]; !found {
				emotes[url] = []string{}
			}
			rangeStr := fmt.Sprintf("%d-%d", match[0], match[1]-1)
			if !contains(emotes[url], rangeStr) {
				emotes[url] = append(emotes[url], rangeStr)
			}
		}
	}

	return emotes
}

// Helper function to check if a slice contains a value
func contains(slice []string, item string) bool {
	for _, v := range slice {
		if v == item {
			return true
		}
	}
	return false
}

func EmoteCacheRefresher() {
	// wait a bit after startup
	time.Sleep(EMOTE_STARTUP_DELAY)
	for {
		UpdateEmoteCacheIfNeeded()
		time.Sleep(EMOTE_CACHE_TIME)
	}
}

func UpdateEmoteCacheIfNeeded() {
	emoteLock.Lock()
	defer emoteLock.Unlock()

	now := time.Now()
	log.Println(now, "|", emoteCache.LastUpdated, "|", EMOTE_CACHE_TIME, "|", emoteCache.StartedUpdating, "|", EMOTE_RETRY_TIME)
	if !emoteCache.LastUpdated.IsZero() && now.Before(emoteCache.LastUpdated.Add(EMOTE_CACHE_TIME)) {
		log.Println("[emotes] 3rd-party emote cache already updated")
		return
	}

	if !emoteCache.StartedUpdating.IsZero() && now.Before(emoteCache.StartedUpdating.Add(EMOTE_RETRY_TIME)) {
		log.Println("[emotes] emote cache update in progress, skipping")
		return
	}

	log.Println("[emotes] updating 3rd-party emote cache")
	emoteCache.StartedUpdating = now

	newMap := make(map[string]string)
	connections := make(map[string]bool)

	// --- Global endpoints ---
	connections["global_bttv"] = false
	connections["global_7tv"] = false
	connections["global_ffz"] = false

	// BTTV Global
	if bttvMap, err := fetchBTTVGlobal(); err == nil {
		connections["global_bttv"] = true
		for code, url := range bttvMap {
			newMap[code] = url
		}
	} else {
		log.Println("[emotes] BTTV global fetch error:", err)
	}

	// 7TV Global
	if stvMap, err := fetch7TVGlobal(); err == nil {
		connections["global_7tv"] = true
		for code, url := range stvMap {
			newMap[code] = url
		}
	} else {
		log.Println("[emotes] 7TV global fetch error:", err)
	}

	// FFZ Global
	if ffzMap, err := fetchFFZGlobal(); err == nil {
		connections["global_ffz"] = true
		for code, url := range ffzMap {
			newMap[code] = url
		}
	} else {
		log.Println("[emotes] FFZ global fetch error:", err)
	}

	// --- Channel endpoints ---
	connections["channel_bttv"] = false
	connections["channel_7tv"] = false
	connections["channel_ffz"] = false

	channelID, err := twitchApi.GetTwitchChannelID(env.TWITCH_CHANNEL, env.TWITCH_CLIENT_ID, env.TWITCH_SECRET)
	if err != nil {
		log.Println("[emotes] Error getting channel ID:", err)
	} else {
		log.Printf("[emotes] Channel %s has ID=%d\n", env.TWITCH_CHANNEL, channelID)

		// BTTV Channel
		if bttvChan, err := fetchBTTVChannel(channelID); err == nil {
			connections["channel_bttv"] = true
			for code, url := range bttvChan {
				newMap[code] = url
			}
		} else {
			log.Println("[emotes] BTTV channel fetch error:", err)
		}

		// 7TV Channel
		if stvChan, err := fetch7TVChannel(channelID); err == nil {
			connections["channel_7tv"] = true
			for code, url := range stvChan {
				newMap[code] = url
			}
		} else {
			log.Println("[emotes] 7TV channel fetch error:", err)
		}

		// FFZ Channel
		if ffzChan, err := fetchFFZChannel(channelID); err == nil {
			connections["channel_ffz"] = true
			for code, url := range ffzChan {
				newMap[code] = url
			}
		} else {
			log.Println("[emotes] FFZ channel fetch error:", err)
		}
	}

	// Save the new data into cache
	emoteCache.Emotes = newMap
	emoteCache.Connections = connections
	emoteCache.LastUpdated = now
	emoteCache.StartedUpdating = time.Time{}

	log.Println("[emotes] done updating 3rd-party emote cache")
}

func GetStatus() map[string]interface{} {
	emoteLock.Lock()
	defer emoteLock.Unlock()
	return map[string]interface{}{
		"NumEmotes":       len(emoteCache.Emotes),
		"Connections":     emoteCache.Connections,
		"LastUpdated":     emoteCache.LastUpdated,
		"StartedUpdating": emoteCache.StartedUpdating,
	}
}
