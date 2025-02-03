package youtubeChat

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	goaway "github.com/TwiN/go-away"
	YtChat "github.com/abhinavxd/youtube-live-chat-downloader/v2"

	"multibot/tenant-container/src/multiChat"
	"multibot/tenant-container/src/props"
	"multibot/tenant-container/src/twitchChat"
	"multibot/tenant-container/src/youtubeApi"
)

const (
	YOUTUBE_MAX_MESSAGE_AGE = 1 * time.Minute
)

var (
	youtubeConnected bool
	youtubeCancel    context.CancelFunc
	youtubeWG        sync.WaitGroup
)

func ConnectToYouTubeLoop() {
	for {
		ConnectToYouTube()
		time.Sleep(1 * time.Minute)
	}
}

func ConnectToYouTube() {
	if !props.GetChannelProp(nil, "enabled").(bool) {
		log.Println("[youtube] bot is disabled, will not connect")
		return
	}
	if youtubeConnected {
		log.Println("[youtube] already connected, will not connect")
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	youtubeCancel = cancel
	youtubeConnected = true

	youtubeID, ok := props.GetChannelProp(ctx, "youtube_id").(string)
	if !ok || youtubeID == "" {
		log.Println("[youtube] no youtube_id set, skipping connect")
		youtubeConnected = false
		return
	}

	// Build a URL for the channel's live stream
	liveURL := fmt.Sprintf("https://www.youtube.com/channel/%s/live", youtubeID)
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
			twitchChat.Say("disconnected from youtube chat")
		}()
		log.Println("[youtube] connected")
		videoID, err := youtubeApi.GetYoutubeLiveVideoID(youtubeID)
		if err != nil {
			log.Printf("[youtube] %s failed to find livestream: %v", youtubeID, err)
		} else {
			log.Printf("[youtube] %s connected to youtube chat: youtu.be/%s", youtubeID, videoID)
			//delay the message a bit to allow the disconnect message to come thru first
			twitchChat.SayLater("connected to youtube chat: youtu.be/" + videoID)
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
				multiChat.SendChat("youtube", msg.AuthorName, "", "", msg.Message, nil)

				// Forward specific commands from YouTube to Twitch
				fwdCmds := props.GetChannelProp(ctx, "fwd_cmds_yt_twitch").([]string)
				for _, cmdStr := range fwdCmds {
					if strings.HasPrefix(msg.Message, cmdStr) {
						log.Println("[youtube] Forwarding command to Twitch:", msg.Message)
						twitchChat.Say(goaway.Censor(msg.Message))
					}
				}
			}
			time.Sleep(2 * time.Second)
		}
	}()
}

func DisconnectFromYouTube() {
	if youtubeConnected {
		log.Println("[youtube] disconnecting")
		if youtubeCancel != nil {
			youtubeCancel()
		}
		youtubeWG.Wait()
		youtubeConnected = false
	}
}

func GetStatus() map[string]interface{} {
	return map[string]interface{}{
		"connected":     youtubeConnected,
		"youtubeCancel": fmt.Sprintf("%#v", youtubeCancel),
	}
}
