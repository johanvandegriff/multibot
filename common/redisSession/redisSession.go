package redisSession

import (
	"bytes"
	"context"
	"encoding/gob"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"multibot/common/env"
	"multibot/common/redisClient"
)

const (
	SESSION_PREFIX   = "sessions/"      // Prefix for session keys in Redis.
	SESSION_COOKIE   = "session_id"     // Name of the cookie that stores the session ID.
	SESSION_USER_KEY = "twitch_user"    // Name of the key to store and retrieve the user.
	SESSION_TTL      = 30 * time.Minute // How long a session lives in Redis.
)

// Session holds session data.
type Session struct {
	ID   string                 `json:"id"`
	Data map[string]interface{} `json:"data"`
}

func saveSession(ctx context.Context, session *Session) error {
	var buf bytes.Buffer
	enc := gob.NewEncoder(&buf)
	if err := enc.Encode(session); err != nil {
		return err
	}
	key := SESSION_PREFIX + session.ID
	return redisClient.Set(ctx, key, buf.Bytes(), SESSION_TTL).Err()
}

func loadSession(ctx context.Context, sessionID string) (*Session, error) {
	key := SESSION_PREFIX + sessionID
	data, err := redisClient.Get(ctx, key).Bytes() // Use .Bytes() when storing raw bytes
	if err == redis.Nil {
		return &Session{
			ID:   sessionID,
			Data: make(map[string]interface{}),
		}, nil
	} else if err != nil {
		return nil, err
	}
	var session Session
	dec := gob.NewDecoder(bytes.NewReader(data))
	if err := dec.Decode(&session); err != nil {
		return nil, err
	}
	return &session, nil
}

// sessionMiddleware is an HTTP middleware that manages sessions.
func SessionMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var sess *Session

		// Try to get the session cookie.
		cookie, err := r.Cookie(SESSION_COOKIE)
		if err != nil || cookie.Value == "" {
			// No valid session cookie found. Create a new session.
			newSessionID := uuid.New().String()
			sess = &Session{
				ID:   newSessionID,
				Data: make(map[string]interface{}),
			}
			// Set the session cookie.
			http.SetCookie(w, &http.Cookie{
				Name:     SESSION_COOKIE,
				Value:    newSessionID,
				Path:     "/",
				HttpOnly: true,
				// Optionally set Secure, SameSite, etc.
			})
		} else {
			// Load the session from Redis.
			sess, err = loadSession(ctx, cookie.Value)
			if err != nil {
				// On error, log it and create a new session.
				log.Printf("Failed to load session: %v. Creating a new session.", err)
				newSessionID := uuid.New().String()
				sess = &Session{
					ID:   newSessionID,
					Data: make(map[string]interface{}),
				}
				http.SetCookie(w, &http.Cookie{
					Name:     SESSION_COOKIE,
					Value:    newSessionID,
					Path:     "/",
					HttpOnly: true,
				})
			}
		}

		// Store the session in the context.
		ctx = context.WithValue(ctx, "session", sess)

		// Let the next handler handle the request.
		next.ServeHTTP(w, r.WithContext(ctx))

		// Save the session back to Redis.
		if err := saveSession(ctx, sess); err != nil {
			log.Printf("Failed to save session: %v", err)
		}
	})
}

func getSession(r *http.Request) *Session {
	session, ok := r.Context().Value("session").(*Session)
	if !ok {
		return nil
	}
	return session
}

type TwitchUser struct {
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

// retrieve the current user from the session
func GetSessionUser(r *http.Request) (*TwitchUser, bool) {
	session := getSession(r)
	if session == nil {
		return nil, false
	}
	user, ok := session.Data[SESSION_USER_KEY].(*TwitchUser)
	if !ok || user == nil {
		return nil, false
	}
	isSuperAdmin := strings.EqualFold(user.Login, env.TWITCH_SUPER_ADMIN_USERNAME)
	return user, isSuperAdmin
}

func SetSessionUser(r *http.Request, user *TwitchUser) error {
	session := getSession(r)
	if session == nil {
		return fmt.Errorf("session error: session is nil")
	}
	session.Data[SESSION_USER_KEY] = user
	return nil
}

func DeleteSessionUser(r *http.Request) {
	session := getSession(r)
	if session == nil {
		return
	}
	delete(session.Data, SESSION_USER_KEY)
}
