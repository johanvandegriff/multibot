package owncastChat

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"multibot/common/src/env"

	"multibot/tenant-container/src/multiChat"
	"multibot/tenant-container/src/props"
	"multibot/tenant-container/src/twitchChat"
)

var (
	owncastConnected bool
	owncastConn      *websocket.Conn
	owncastCloseMu   sync.Mutex // to guard owncastConn
)

func ConnectToOwncastLoop() {
	for {
		ConnectToOwncast()
		time.Sleep(1 * time.Minute)
	}
}

func ConnectToOwncast() {
	if !props.GetChannelProp(nil, "enabled").(bool) {
		log.Println("[owncast] bot is disabled, will not connect")
		return
	}
	if owncastConnected {
		log.Println("[owncast] already connected, will not connect")
		return
	}
	ocURLRaw := props.GetChannelProp(nil, "owncast_url")
	owncastURL, _ := ocURLRaw.(string)
	if owncastURL == "" {
		log.Println("[owncast] no owncast_url, skipping connect")
		return
	}
	regBody := map[string]any{"displayName": env.DEFAULT_BOT_NICKNAME}
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
	twitchChat.SayLater("connected to owncast chat: https://" + owncastURL)

	go func() {
		defer DisconnectFromOwncast()
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
			multiChat.SendChat("owncast", dispName, "", color, body, emotes)
			return
		}
	}
	multiChat.SendChat("owncast", dispName, "", color, body, nil)
}

func DisconnectFromOwncast() {
	owncastCloseMu.Lock()
	defer owncastCloseMu.Unlock()
	if owncastConnected && owncastConn != nil {
		log.Println("[owncast] disconnecting")
		owncastConn.Close()
		owncastConn = nil
		owncastConnected = false
		twitchChat.Say("disconnected from owncast chat")
	}
}

func GetStatus() map[string]interface{} {
	return map[string]interface{}{
		"connected":   owncastConnected,
		"owncastConn": strings.ReplaceAll(strings.ReplaceAll(fmt.Sprintf("%#v", owncastConn), "0x0, ", ""), "0x0", "..."),
	}
}
