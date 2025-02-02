package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// Twitch official emote
func TwitchCDN(id string, size int) string {
	// size=0 => "1.0", size=1 => "2.0", etc.
	return fmt.Sprintf("https://static-cdn.jtvnw.net/emoticons/v2/%s/default/dark/%d.0", id, size+1)
}

// BTTV
func BTTVGlobalEndpoint() string { return "https://api.betterttv.net/3/cached/emotes/global" }
func BTTVChannelEndpoint(twitchUserID int) string {
	return fmt.Sprintf("https://api.betterttv.net/3/cached/users/twitch/%d", twitchUserID)
}
func BTTVCDN(id string, size int) string {
	// size=0 => "1x", size=1 => "2x", etc.
	return fmt.Sprintf("https://cdn.betterttv.net/emote/%s/%dx.webp", id, size+1)
}

// 7TV
func SevenTVGlobalEndpoint() string { return "https://7tv.io/v3/emote-sets/global" }
func SevenTVChannelEndpoint(twitchUserID int) string {
	// 7tv uses: /v3/users/twitch/<id> for channel
	return fmt.Sprintf("https://7tv.io/v3/users/twitch/%d", twitchUserID)
}
func SevenTVCDN(id string, size string) string {
	// size might be "1x.webp", "2x.webp", "3x.webp" etc.
	return fmt.Sprintf("https://cdn.7tv.app/emote/%s/%s", id, size)
}

// FFZ
func FFZSetEndpoint(setID int) string {
	return fmt.Sprintf("https://api.frankerfacez.com/v1/set/%d", setID)
}
func FFZChannelEndpoint(twitchUserID int) string {
	// e.g. "https://api.frankerfacez.com/v1/room/id/123456"
	return fmt.Sprintf("https://api.frankerfacez.com/v1/room/id/%d", twitchUserID)
}
func FFZCDN(id string, size int) string {
	// size=1 => ".../1", size=2 => ".../2", etc.
	return fmt.Sprintf("https://cdn.frankerfacez.com/emote/%s/%d", id, size)
}
func FFZCDNAnimated(id string, size int) string {
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
func FetchBTTVGlobal() (map[string]string, error) {
	out := make(map[string]string)
	resp, err := http.Get(BTTVGlobalEndpoint())
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
		out[e.Code] = BTTVCDN(e.ID, 2) // 2 => "3x"
	}
	return out, nil
}

// Fetch channel BTTV emotes by numeric Twitch userID
func FetchBTTVChannel(twitchUserID int) (map[string]string, error) {
	out := make(map[string]string)
	url := BTTVChannelEndpoint(twitchUserID)
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
		out[e.Code] = BTTVCDN(e.ID, 2)
	}
	for _, e := range data.SharedEmotes {
		out[e.Code] = BTTVCDN(e.ID, 2)
	}
	return out, nil
}

// Fetch 7TV global emotes
func Fetch7TVGlobal() (map[string]string, error) {
	out := make(map[string]string)
	resp, err := http.Get(SevenTVGlobalEndpoint())
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
		out[e.Name] = SevenTVCDN(e.ID, "3x.webp")
	}
	return out, nil
}

// Fetch 7TV channel emotes
func Fetch7TVChannel(twitchUserID int) (map[string]string, error) {
	out := make(map[string]string)
	url := SevenTVChannelEndpoint(twitchUserID)
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
		out[e.Name] = SevenTVCDN(e.ID, "3x.webp")
	}
	return out, nil
}

// For FFZ "global sets", you can fetch set 3 or others from your Node snippet.
// Or you can fetch them from the "v1/set/global" route.
// But let's do set=3 (the "main" global set).
func FetchFFZGlobal() (map[string]string, error) {
	out := make(map[string]string)
	const globalSetID = 3
	url := FFZSetEndpoint(globalSetID)
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
				out[e.Name] = FFZCDNAnimated(strconv.Itoa(e.ID), 2)
			} else {
				out[e.Name] = FFZCDN(strconv.Itoa(e.ID), 2)
			}
		}
	}
	return out, nil
}

// Fetch channel-specific FFZ emotes
func FetchFFZChannel(twitchUserID int) (map[string]string, error) {
	out := make(map[string]string)
	url := FFZChannelEndpoint(twitchUserID)
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
				out[e.Name] = FFZCDNAnimated(strconv.Itoa(e.ID), 2)
			} else {
				out[e.Name] = FFZCDN(strconv.Itoa(e.ID), 2)
			}
		}
	}
	return out, nil
}

func FetchAllGlobalEmotes() (map[string]string, error) {
	emotes := make(map[string]string)

	// 1. BTTV Global
	if bttvMap, err := FetchBTTVGlobal(); err == nil {
		for code, url := range bttvMap {
			emotes[code] = url
		}
	} else {
		// handle error or log
	}

	// 2. 7TV Global
	if stvMap, err := Fetch7TVGlobal(); err == nil {
		for code, url := range stvMap {
			emotes[code] = url
		}
	} else {
		// handle error or log
	}

	// 3. FFZ Global
	if ffzMap, err := FetchFFZGlobal(); err == nil {
		for code, url := range ffzMap {
			emotes[code] = url
		}
	} else {
		// handle error
	}

	// Return the combined map
	return emotes, nil
}

// Example for channel
func FetchAllChannelEmotes(twitchUserID int) (map[string]string, error) {
	emotes := make(map[string]string)

	// BTTV
	if bttvMap, err := FetchBTTVChannel(twitchUserID); err == nil {
		for code, url := range bttvMap {
			emotes[code] = url
		}
	}

	// 7TV
	if stvMap, err := Fetch7TVChannel(twitchUserID); err == nil {
		for code, url := range stvMap {
			emotes[code] = url
		}
	}

	// FFZ
	if ffzMap, err := FetchFFZChannel(twitchUserID); err == nil {
		for code, url := range ffzMap {
			emotes[code] = url
		}
	}

	return emotes, nil
}

type YoutubeEmote struct {
	ID   string `json:"id"`
	Code string `json:"code"`
}

var (
	_youtubeEmotes = make(map[string]string) // Maps `:emote_code:` -> Emote URL
)

// Load YouTube emotes from a local JSON file
func getYouTubeEmotes() map[string]string {
	if len(_youtubeEmotes) > 0 {
		log.Printf("[youtube] %d emotes already loaded, skipping", len(_youtubeEmotes))
		return _youtubeEmotes
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

	_youtubeEmotes = newEmoteMap
	log.Printf("[youtube] loaded %d emotes", len(_youtubeEmotes))
	return _youtubeEmotes
}

// find3rdPartyEmotes scans the user’s raw text for codes that match the known emotes from our cache
// and returns a map[url] => []ranges, same as the Node version does.
func find3rdPartyEmotes(msg string) map[string][]string {
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
