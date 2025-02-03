package twitchChat

import (
	"context"
	"fmt"
	"log"
	"math/rand"
	"strings"
	"sync"
	"time"

	goaway "github.com/TwiN/go-away"
	"github.com/gempir/go-twitch-irc/v4"

	"multibot/common/env"
	"multibot/tenant-container/src/multiChat"
	"multibot/tenant-container/src/props"
)

const (
	TWITCH_MESSAGE_DELAY     = 500 * time.Millisecond //time to wait between twitch chats for both to go thru
	GREETZ_DELAY_FOR_COMMAND = 2 * time.Second        //wait to greet when the user ran a command
)

var (
	twitchClient    *twitch.Client
	twitchConnected bool

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

	// Greet tracking: lastSeens stores last time a user talked (in ms).
	lastSeens     = make(map[string]int64)
	lastSeensLock sync.Mutex

	ctxb = context.Background()
)

// -----------------------------------------------------------------------------
//  Twitch bridging
// -----------------------------------------------------------------------------

func ConnectToTwitchLoop() {
	for {
		ConnectToTwitch()
		time.Sleep(1 * time.Minute)
	}
}

func ConnectToTwitch() {
	ctx := context.Background()
	if !props.GetChannelProp(ctx, "enabled").(bool) {
		log.Println("[twitch] bot is disabled, will not connect")
		return
	}
	if twitchConnected {
		log.Println("[twitch] already connected, will not connect")
		return
	}
	log.Printf("[twitch] connecting as %s to channel %s\n", env.TWITCH_BOT_USERNAME, env.TWITCH_CHANNEL)
	twitchClient = twitch.NewClient(env.TWITCH_BOT_USERNAME, env.TWITCH_BOT_OAUTH_TOKEN)
	// Callback for normal chat messages
	twitchClient.OnPrivateMessage(func(msg twitch.PrivateMessage) {
		// Ignore our own bot messages
		if strings.EqualFold(msg.User.Name, env.TWITCH_BOT_USERNAME) {
			return
		}
		// Ignore whispers or messages from other channels
		if !strings.EqualFold(msg.Channel, env.TWITCH_CHANNEL) {
			return
		}

		ctx := context.Background()
		username := msg.User.DisplayName
		if username == "" {
			username = msg.User.Name
		}
		nickname, _ := props.GetViewerProp(ctx, username, "nickname").(string)

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
		multiChat.SendChat("twitch", username, nickname, color, msg.Message, emoteMap)

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
		twitchClient.Join(env.TWITCH_CHANNEL)
		twitchConnected = true
	})

	go func() {
		if err := twitchClient.Connect(); err != nil {
			log.Println("[twitch] connect error:", err)
			twitchConnected = false
		}
	}()
}

func Say(message string) {
	if twitchClient == nil || !twitchConnected {
		return
	}
	twitchClient.Say(env.TWITCH_CHANNEL, message)

	nickname, _ := props.GetViewerProp(context.Background(), env.TWITCH_BOT_USERNAME, "nickname").(string)
	multiChat.SendChat("twitch", env.TWITCH_BOT_USERNAME, nickname, "", message, nil)
}

func SayLater(message string) {
	go func() {
		time.Sleep(TWITCH_MESSAGE_DELAY)
		Say(message)
	}()
}

func DisconnectFromTwitch() {
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
		Say(`commands: !nick - set your nickname; !botpage - link to the page with nicknames and other info; !multichat - link to combined chat; !clear - clear the multichat`)
	case command == "!botpage":
		Say(fmt.Sprintf("see the nicknames and other bot info at %s/%s", env.BASE_URL, env.TWITCH_CHANNEL))
	case command == "!multichat":
		Say(fmt.Sprintf("see the multichat at %s/%s/chat (change font and show/hide options on !botpage)", env.BASE_URL, env.TWITCH_CHANNEL))
	case command == "!clear":
		// Only allow if user is mod, broadcaster, or super admin
		if msg.User.IsMod || strings.EqualFold(msg.User.Name, env.TWITCH_CHANNEL) || strings.EqualFold(msg.User.Name, env.TWITCH_SUPER_ADMIN_USERNAME) {
			multiChat.ClearChat()
			shouldReply = false
		} else {
			Say(fmt.Sprintf("@%s you do not have permission to clear chat", username))
		}
	case command == "!nick":
		ctx := context.Background()
		curr := props.GetViewerProp(ctx, username, "nickname")
		if curr != nil {
			props.SetViewerProp(ctx, username, "nickname", nil)
			Say(fmt.Sprintf("@%s removed nickname, sad to see you go", username))
		} else {
			Say(fmt.Sprintf("@%s please provide a nickname, e.g. !nick name", username))
		}
	case strings.HasPrefix(command, "!nick "):
		ctx := context.Background()
		parts := strings.SplitN(command, " ", 2)
		if len(parts) < 2 {
			Say(fmt.Sprintf("@%s please provide a nickname after !nick", username))
			break
		}
		nickname := strings.TrimSpace(parts[1])
		maxLen := props.GetChannelPropAs(ctx, "max_nickname_length", 0)

		if goaway.IsProfane(nickname) {
			Say(fmt.Sprintf("@%s no profanity allowed in nickname, choose a different one", username))
		} else if props.GetViewerProp(ctx, username, "nickname") == nickname {
			Say(fmt.Sprintf("@%s you already have that nickname", username))
		} else if len(nickname) > maxLen {
			Say(fmt.Sprintf("@%s nickname \"%s\" is too long, max length = %d", username, nickname, maxLen))
		} else if isNicknameTaken(nickname) {
			Say(fmt.Sprintf("@%s nickname \"%s\" is already taken, see !botpage for the list", username, nickname))
		} else {
			props.SetViewerProp(ctx, username, "nickname", nickname)
			Say(fmt.Sprintf("@%s set nickname to %s", username, nickname))
		}
	default:
		validCommand = false
	}
	return validCommand, shouldReply
}

// isNicknameTaken checks if any other user is using the given nickname
func isNicknameTaken(nick string) bool {
	ctx := context.Background()
	viewers := props.ListViewers(ctx)
	for _, v := range viewers {
		val := props.GetViewerProp(ctx, v, "nickname")
		if valStr, ok := val.(string); ok && valStr == nick {
			return true
		}
	}
	return false
}

func greetz(username string, validCommand, shouldReply bool) {
	if strings.EqualFold(username, env.TWITCH_BOT_USERNAME) {
		return
	}
	// Only greet if the user has a nickname set (like in Node).
	nick := props.GetViewerProp(ctxb, username, "nickname")
	if nick == nil {
		return
	}

	// Retrieve the last time we saw this user
	lastSeensLock.Lock()
	lastSeen, hasSeen := lastSeens[username]
	nowMs := time.Now().UnixMilli()
	lastSeensLock.Unlock()

	greetzThreshold := props.GetChannelPropAs(ctxb, "greetz_threshold", int64(0))
	wbThreshold := props.GetChannelPropAs(ctxb, "greetz_wb_threshold", int64(0))

	if !hasSeen || (nowMs-lastSeen > greetzThreshold) {
		// They’ve been away a long time => use initial greet
		if shouldReply && validCommand {
			// If they typed a valid command, wait 2s, then greet with "also" variant
			go func(u string) {
				time.Sleep(GREETZ_DELAY_FOR_COMMAND)
				Say(parseGreetz(GREETZ_ALSO, u))
			}(username)
		} else {
			Say(parseGreetz(GREETZ, username))
		}
	} else if !hasSeen || (nowMs-lastSeen > wbThreshold) {
		// They’ve been away for a shorter threshold => welcome back
		if shouldReply && validCommand {
			go func(u string) {
				time.Sleep(GREETZ_DELAY_FOR_COMMAND)
				Say(parseGreetz(GREETZ_WELCOME_BACK_ALSO, u))
			}(username)
		} else {
			Say(parseGreetz(GREETZ_WELCOME_BACK, username))
		}
	}

	// Update lastSeens
	lastSeensLock.Lock()
	lastSeens[username] = nowMs
	lastSeensLock.Unlock()
}

func parseGreetz(stock []string, username string) string {
	nickname, _ := props.GetViewerProp(ctxb, username, "nickname").(string)
	custom, _ := props.GetViewerProp(ctxb, username, "custom_greetz").(string)

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

func GetStatus() map[string]interface{} {
	return map[string]interface{}{
		"connected":    twitchConnected,
		"twitchClient": fmt.Sprintf("%#v", twitchClient),
	}
}
