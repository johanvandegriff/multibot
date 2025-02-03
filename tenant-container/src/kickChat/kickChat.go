package kickChat

import (
	"fmt"
	"log"
	"time"

	kickchatwrapper "github.com/johanvandegriff/kick-chat-wrapper"

	"multibot/tenant-container/src/multiChat"
	"multibot/tenant-container/src/props"
)

var (
	kickConnected    bool
	kickClient     *kickchatwrapper.Client
)

func ConnectToKickLoop() {
	for {
		ConnectToKick()
		time.Sleep(1 * time.Minute)
	}
}

func ConnectToKick() {
	if !props.GetChannelProp(nil, "enabled").(bool) {
		log.Println("[kick] bot is disabled, will not connect")
		return
	}
	if kickConnected {
		log.Println("[kick] already connected, will not connect")
		return
	}
	kcRaw := props.GetChannelProp(nil, "kick_chatroom_id")
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
		defer DisconnectFromKick()
		for m := range msgChan {
			if !kickConnected {
				log.Println("[kick] got message while not connected:", m)
				continue
			}
			// m.Sender.Username, m.Content, m.Sender.Identity.Color, etc.
			if m.Sender.Username == "" {
				continue
			}
			multiChat.SendChat("kick", m.Sender.Username, "", m.Sender.Identity.Color, m.Content, nil)
		}
	}()
}

func parseChannelID(s string) (int, error) {
	var id int
	_, err := fmt.Sscanf(s, "%d", &id)
	return id, err
}

func DisconnectFromKick() {
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

func GetStatus() map[string]interface{} {
	return map[string]interface{}{
		"connected":  kickConnected,
		"kickClient": fmt.Sprintf("%#v", kickClient),
	}
}
