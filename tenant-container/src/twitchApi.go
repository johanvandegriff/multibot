package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
)

// TwitchTokenResponse is the structure of Twitch's OAuth token response.
type TwitchTokenResponse struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   int    `json:"expires_in"`
	TokenType   string `json:"token_type"`
}

// getTwitchAppAccessToken fetches a new App Access Token using
// the client_credentials flow. It returns (token, expiresInSeconds, error).
func getTwitchAppAccessToken(clientID string, clientSecret string) (string, int, error) {
	endpoint := "https://id.twitch.tv/oauth2/token"
	values := url.Values{}
	values.Set("client_id", clientID)
	values.Set("client_secret", clientSecret)
	values.Set("grant_type", "client_credentials")

	resp, err := http.PostForm(endpoint, values)
	if err != nil {
		return "", 0, fmt.Errorf("error requesting token: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", 0, fmt.Errorf("token request failed: status=%d body=%s",
			resp.StatusCode, string(body))
	}

	var tokenResp TwitchTokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
		return "", 0, fmt.Errorf("error decoding token JSON: %w", err)
	}

	return tokenResp.AccessToken, tokenResp.ExpiresIn, nil
}


type helixUsersResponse struct {
	Data []struct {
		ID              string `json:"id"`
		Login           string `json:"login"`
		DisplayName     string `json:"display_name"`
		BroadcasterType string `json:"broadcaster_type"`
		Description     string `json:"description"`
		ViewCount       int    `json:"view_count"`
	} `json:"data"`
	Error        string `json:"error,omitempty"`
	Status       int    `json:"status,omitempty"`
	Message      string `json:"message,omitempty"`
}

func getTwitchChannelID(channelName string, clientID string, clientSecret string) (int, error) {
	token, _, err := getTwitchAppAccessToken(clientID, clientSecret)
	if err != nil {
		fmt.Println("Error fetching token:", err)
		return 0, err
	}

	// fmt.Println("Got token:", token)
	// fmt.Printf("Expires in: %d seconds (≈ %v)\n",
	// 	expiresIn, time.Duration(expiresIn)*time.Second)
	// Use this token in Helix calls:
	//   Authorization: Bearer <token>
	//   Client-ID: <clientID>

	// If your token is "oauth:abcd", remove "oauth:" prefix
	// token := TWITCH_BOT_OAUTH_TOKEN
	// if len(token) > 6 && token[:6] == "oauth:" {
	// 	token = token[6:]
	// }

	req, err := http.NewRequest("GET",
		fmt.Sprintf("https://api.twitch.tv/helix/users?login=%s", channelName),
		nil,
	)
	if err != nil {
		return 0, err
	}
	// Set Helix-required headers:
	req.Header.Set("Client-ID", clientID)
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return 0, fmt.Errorf("helix users error status=%d body=%s", resp.StatusCode, string(bodyBytes))
	}

	var data helixUsersResponse
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return 0, err
	}

	if len(data.Data) == 0 {
		return 0, fmt.Errorf("no users found for channel=%s", channelName)
	}

	// Helix returns the user ID as a string, convert to int
	idStr := data.Data[0].ID
	userID, err := strconv.Atoi(idStr)
	if err != nil {
		return 0, err
	}
	return userID, nil
}
