package youtubeApi

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
)

// returns the first live video ID
func GetYoutubeLiveVideoID(youtubeID string) (string, error) {
	liveVids, err := getYoutubeLiveVideoIDs(youtubeID)
	if err != nil || len(liveVids) == 0 {
		return "", fmt.Errorf("no live video found")
	}
	return liveVids[0], nil
}

// finds all live stream video IDs
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

// fetches and extracts ytInitialData JSON from a youtube channel page
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

// recursively searches for a key in JSON and calls the callback on found entries
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

func FindYoutubeIDHandler(w http.ResponseWriter, r *http.Request) {
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
